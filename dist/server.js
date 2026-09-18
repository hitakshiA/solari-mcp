#!/usr/bin/env node
// solari-mcp — a Model Context Protocol server that lets agents (Claude
// Desktop/Code, Cursor, Windsurf, …) drive Solari sandboxes + desktops.
//
// Stdio transport. Auth via SOLARI_API_KEY (+ optional SOLARI_BASE_URL).
// MCP tool calls are stateless, so the server keeps a session registry keyed by
// sessionId: create tools return an id, and the rest take it.
//
// The toolset is built as a plain map (makeToolset) so it can be unit-tested
// against a mock SolariClient without an MCP transport.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SolariClient } from "@solarisdk/sdk";
import { VERSION } from "./version.js";
import { makeBrowserToolset, releaseAllBrowserSessions, } from "./browser.js";
// Guest output (file reads, command stdout, code results) is unbounded on the
// wire; cap it so one `cat` of a big file can't blow the MCP payload budget or
// OOM the shared hosted task.
const MAX_TOOL_TEXT = 30_000;
// Pages of `GET /sandboxes` solari_list will follow per kind (100 rows each).
const MAX_LIST_PAGES = 5;
const text = (o) => {
    const s = typeof o === "string" ? o : JSON.stringify(o, null, 2);
    const capped = s.length > MAX_TOOL_TEXT
        ? `${s.slice(0, MAX_TOOL_TEXT)}\n…[truncated ${s.length - MAX_TOOL_TEXT} of ${s.length} chars]`
        : s;
    return { content: [{ type: "text", text: capped }] };
};
export function makeToolset(client, reg) {
    const need = (id) => {
        const e = reg.sessions.get(id);
        if (!e)
            throw new Error(`unknown sessionId: ${id}`);
        return e;
    };
    // A paused session refuses the /control upgrade with 409, so resume it and
    // retry rather than surfacing an opaque websocket error.
    const live = async (id) => {
        const e = need(id);
        if (e.handle.connected)
            return e;
        try {
            await e.handle.connect();
        }
        catch (err) {
            if (typeof e.handle.resume !== "function")
                throw err;
            await e.handle.resume();
            await e.handle.connect();
        }
        return e;
    };
    const desktop = async (id) => {
        const e = await live(id);
        if (e.kind !== "desktop")
            throw new Error(`session ${id} is a sandbox; this tool needs a desktop`);
        return e;
    };
    return {
        solari_sandbox_create: {
            description: "Create a headless sandbox (microVM). Returns its sessionId.",
            inputSchema: { template: z.string().optional(), cpu: z.number().optional(), memMb: z.number().optional() },
            handler: async (a) => {
                const sbx = await client.sandboxes.create({
                    ...(a.template ? { template: a.template } : {}),
                    ...(a.cpu ? { cpu: a.cpu } : {}),
                    ...(a.memMb ? { memMb: a.memMb } : {}),
                });
                reg.sessions.set(sbx.sandboxId, { kind: "sandbox", handle: sbx, commands: [] });
                return text({ sessionId: sbx.sandboxId });
            },
        },
        solari_desktop_create: {
            description: "Create a GUI desktop (microVM). Returns sessionId + streamUrl (noVNC).",
            inputSchema: { template: z.string().optional(), resolution: z.string().optional() },
            handler: async (a) => {
                const d = await client.desktops.create({
                    ...(a.template ? { template: a.template } : {}),
                    ...(a.resolution ? { resolution: a.resolution } : {}),
                });
                reg.sessions.set(d.sessionId, { kind: "desktop", handle: d, commands: [] });
                return text({ sessionId: d.sessionId, streamUrl: d.streamUrl });
            },
        },
        solari_list: {
            description: "List the org's live VMs — BOTH sandboxes and desktops. Each entry is labelled " +
                "with its `kind`; `registered:true` means this MCP session already holds a handle " +
                "so the other tools accept its sessionId directly (otherwise call solari_connect " +
                "first). Optional kind/state filters.",
            inputSchema: {
                kind: z.enum(["sandbox", "desktop"]).optional(),
                state: z.string().optional(),
            },
            handler: async (a) => {
                // GET /sandboxes is the unified VM index (desktops write the same
                // SandboxRecord), but it is queried per-kind here so the two flavours
                // are merged EXPLICITLY: an agent asking "what do I have running"
                // must never silently lose desktops to a default filter, and the
                // per-kind counts are what make the answer legible.
                const kinds = a.kind ? [a.kind] : ["sandbox", "desktop"];
                const vms = [];
                const counts = { sandbox: 0, desktop: 0 };
                let truncated = false;
                for (const kind of kinds) {
                    // Follow nextCursor so a big org's desktops aren't cut off by the
                    // gateway's 100-row default page — bounded so one call can't spin.
                    let cursor;
                    for (let page = 0; page < MAX_LIST_PAGES; page++) {
                        const res = await client.sandboxes.list({
                            kind,
                            // `state` is a closed union on the SDK; an unknown value is
                            // simply ignored by the gateway, so pass it through.
                            ...(a.state ? { state: a.state } : {}),
                            ...(cursor ? { cursor } : {}),
                        });
                        for (const v of res.sandboxes ?? []) {
                            const rec = v;
                            // The wire calls the id `sandboxId` for both kinds; re-label it
                            // `sessionId` because that is what every other tool here takes.
                            const id = (rec.sandboxId ?? rec.sessionId);
                            const k = rec.kind ?? kind;
                            vms.push({
                                ...rec,
                                ...(id ? { sessionId: id } : {}),
                                kind: k,
                                registered: id ? reg.sessions.has(id) : false,
                            });
                            counts[k] = (counts[k] ?? 0) + 1;
                        }
                        cursor = res.nextCursor;
                        if (!cursor)
                            break;
                        if (page === MAX_LIST_PAGES - 1)
                            truncated = true;
                    }
                }
                return text({ counts, total: vms.length, ...(truncated ? { truncated } : {}), vms });
            },
        },
        solari_kill: {
            description: "Destroy a session by id.",
            inputSchema: { sessionId: z.string() },
            handler: async (a) => {
                const e = need(a.sessionId);
                await e.handle.kill();
                reg.sessions.delete(a.sessionId);
                return text({ ok: true });
            },
        },
        solari_exec: {
            description: "Run a shell command in a session. Returns { stdout, stderr, exitCode }.",
            inputSchema: { sessionId: z.string(), command: z.string() },
            handler: async (a) => {
                const e = await live(a.sessionId);
                // Guest exec is no-shell (cmd = binary + argv); route through sh -c so
                // pipes, $(), globs and quoting behave the way "shell command" implies.
                return text(await e.handle.commands.run("sh", { args: ["-c", a.command] }));
            },
        },
        solari_run_command_bg: {
            description: "Start a shell command in the background (non-blocking). Returns its cmdId; the process keeps running after this call.",
            inputSchema: { sessionId: z.string(), command: z.string() },
            handler: async (a) => {
                const e = await live(a.sessionId);
                const h = await e.handle.commands.start("sh", { args: ["-c", a.command] });
                // commands.start() arms an exit promise that REJECTS when the control
                // channel closes (kill, idle-pause, gateway redeploy). Nothing else
                // awaits it, so without this catch the rejection is unhandled and Node
                // terminates the process — taking every other tenant's session with it
                // on the hosted server.
                void h.wait?.().catch(() => { });
                e.commands.push(h);
                return text({ cmdId: h.cmdId });
            },
        },
        solari_get_preview_url: {
            description: "Get a public preview URL for an in-guest port (e.g. a dev server on :3000). Returns { url, token? }.",
            inputSchema: { sessionId: z.string(), port: z.number() },
            handler: async (a) => {
                const e = await live(a.sessionId);
                return text(await e.handle.previewUrl(a.port));
            },
        },
        solari_connect: {
            description: "Re-attach to an existing sandbox or desktop by id (e.g. across restarts); resumes it if " +
                "paused. The kind is read from the gateway, so you don't need to know it. Returns { sessionId, kind, state }.",
            inputSchema: { sessionId: z.string(), kind: z.enum(["sandbox", "desktop"]).optional() },
            handler: async (a) => {
                const id = a.sessionId;
                // Trust the gateway over the caller's hint: guessing "sandbox" for a
                // desktop permanently misclassifies it and every GUI tool then wrongly
                // refuses the session.
                let kind = a.kind ?? reg.sessions.get(id)?.kind ?? "sandbox";
                let state;
                try {
                    const view = await client.sandboxes.get(id);
                    if (view?.kind === "desktop" || view?.kind === "sandbox")
                        kind = view.kind;
                    state = view?.state;
                }
                catch {
                    /* fall back to the hint */
                }
                const handle = kind === "desktop"
                    ? await client.desktops.connect(id)
                    : await client.sandboxes.connect(id);
                // desktops.connect() auto-resumes; sandboxes.connect() does not.
                if (kind === "sandbox" && state === "paused" && typeof handle.resume === "function") {
                    await handle.resume();
                }
                reg.sessions.set(id, { kind, handle, commands: [] });
                return text({ sessionId: id, kind, state: state ?? "unknown" });
            },
        },
        solari_run_code: {
            description: "Run code (default Python) in a session's kernel. Returns results incl. structured charts.",
            inputSchema: { sessionId: z.string(), code: z.string(), language: z.string().optional() },
            handler: async (a) => {
                const e = await live(a.sessionId);
                return text(await e.handle.runCode(a.code, a.language ? { language: a.language } : {}));
            },
        },
        solari_read_file: {
            description: "Read an in-guest text file.",
            inputSchema: { sessionId: z.string(), path: z.string() },
            handler: async (a) => {
                const e = await live(a.sessionId);
                return text(await e.handle.files.readText(a.path));
            },
        },
        solari_write_file: {
            description: "Write a text file into the guest.",
            inputSchema: { sessionId: z.string(), path: z.string(), content: z.string() },
            handler: async (a) => {
                const e = await live(a.sessionId);
                await e.handle.files.write(a.path, a.content);
                return text({ ok: true });
            },
        },
        solari_list_files: {
            description: "List a guest directory.",
            inputSchema: { sessionId: z.string(), path: z.string() },
            handler: async (a) => {
                const e = await live(a.sessionId);
                return text(await e.handle.files.list(a.path));
            },
        },
        solari_screenshot: {
            description: "Capture the desktop screen as a PNG image.",
            inputSchema: { sessionId: z.string() },
            handler: async (a) => {
                const e = await desktop(a.sessionId);
                const png = await e.handle.screenshot();
                return { content: [{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" }] };
            },
        },
        solari_click: {
            description: "Click the desktop at (x, y).",
            inputSchema: { sessionId: z.string(), x: z.number(), y: z.number() },
            handler: async (a) => {
                const e = await desktop(a.sessionId);
                await e.handle.mouse.click(a.x, a.y);
                return text({ ok: true });
            },
        },
        solari_type: {
            description: "Type text into the focused desktop element.",
            inputSchema: { sessionId: z.string(), text: z.string() },
            handler: async (a) => {
                const e = await desktop(a.sessionId);
                await e.handle.keyboard.type(a.text);
                return text({ ok: true });
            },
        },
        solari_key: {
            description: "Press a key or chord (e.g. 'Return', 'ctrl+c') on the desktop.",
            inputSchema: { sessionId: z.string(), key: z.string() },
            handler: async (a) => {
                const e = await desktop(a.sessionId);
                await e.handle.keyboard.press(a.key);
                return text({ ok: true });
            },
        },
        solari_open_app: {
            description: "Launch an application on the desktop. Returns its pid.",
            inputSchema: { sessionId: z.string(), name: z.string() },
            handler: async (a) => {
                const e = await desktop(a.sessionId);
                return text({ pid: await e.handle.open(a.name) });
            },
        },
    };
}
export function registerToolset(server, toolset) {
    for (const [name, t] of Object.entries(toolset)) {
        server.registerTool(name, { description: t.description, inputSchema: t.inputSchema }, 
        // The MCP SDK passes validated args; our handlers accept a record.
        async (args) => t.handler(args));
    }
}
/**
 * Drop our control-channel sockets for every sandbox/desktop in a registry.
 *
 * This is required, not cosmetic: the gateway treats a session with any open
 * control/stream connection as active and never expires it, so leaving the
 * channel open defeats idle-pause and the VM bills indefinitely. We close
 * (not kill) so the customer keeps their VM and its own idle policy applies.
 */
export async function closeAllVmSessions(reg) {
    const ids = [...reg.sessions.keys()];
    await Promise.all(ids.map(async (id) => {
        const e = reg.sessions.get(id);
        reg.sessions.delete(id);
        try {
            await e?.handle.close?.();
        }
        catch (err) {
            console.error(`solari-mcp: failed to close session ${id}:`, err);
        }
    }));
}
export function buildServerParts(client, browserCfg) {
    const apiKey = browserCfg?.apiKey ?? process.env.SOLARI_API_KEY ?? "";
    const c = client ??
        new SolariClient({
            apiKey,
            ...(process.env.SOLARI_BASE_URL ? { baseUrl: process.env.SOLARI_BASE_URL } : {}),
        });
    // The cloud-browser gateway is a separate service from the sandbox/desktop
    // gateway (same domain in prod, different domains on staging).
    // Prod's browser + desktop gateways have separate key stores today; allow a
    // browser-specific key (falls back to the shared one).
    const bCfg = browserCfg ?? {
        apiKey: process.env.SOLARI_BROWSER_API_KEY ?? apiKey,
        baseUrl: process.env.SOLARI_BROWSER_URL ??
            process.env.SOLARI_BASE_URL ??
            "https://api.getsolari.com",
    };
    const server = new McpServer({ name: "solari-mcp", version: VERSION });
    const browserReg = { sessions: new Map() };
    const vmReg = { sessions: new Map() };
    registerToolset(server, {
        ...makeToolset(c, vmReg),
        ...makeBrowserToolset(bCfg, browserReg),
    });
    return { server, browserReg, vmReg, browserCfg: bCfg };
}
export function buildServer(client, browserCfg) {
    return buildServerParts(client, browserCfg).server;
}
export async function main() {
    if (!process.env.SOLARI_API_KEY) {
        console.error("solari-mcp: SOLARI_API_KEY is required");
        process.exit(1);
    }
    // A stray rejection (e.g. a background command's exit promise) must never
    // take the server down mid-session.
    process.on("unhandledRejection", (err) => {
        console.error("solari-mcp: unhandled rejection (ignored):", err);
    });
    const parts = buildServerParts();
    // Without this, every exit (client quit, Ctrl-C, host restart) leaves browser
    // sessions held to their TTL and VM control channels open — which pins the
    // VMs active so they never idle-pause. Both bill until cleaned up.
    let shuttingDown = false;
    const shutdown = async (sig) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        console.error(`solari-mcp: ${sig} — releasing sessions`);
        await Promise.race([
            Promise.allSettled([
                releaseAllBrowserSessions(parts.browserCfg, parts.browserReg),
                closeAllVmSessions(parts.vmReg),
            ]),
            new Promise((r) => setTimeout(r, 10_000)),
        ]);
        process.exit(0);
    };
    for (const sig of ["SIGTERM", "SIGINT"]) {
        process.on(sig, () => void shutdown(sig));
    }
    await parts.server.connect(new StdioServerTransport());
}
// Run only when executed as the binary (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error("solari-mcp fatal:", err);
        process.exit(1);
    });
}
