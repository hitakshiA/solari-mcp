#!/usr/bin/env node
// solari-mcp over Streamable HTTP — the hosted, multi-tenant variant.
//
// One deployment serves every customer: each MCP session is bound to the
// slr_live_ API key presented in the Authorization header at initialize time,
// and gets its own McpServer + tool registries. Subsequent requests are routed
// by the mcp-session-id header and must present the same key (sessions are a
// tenant boundary, not just a transport detail).
//
//   PORT                 listen port (default 8080)
//   SOLARI_BASE_URL      sandbox/desktop gateway (default https://api.getsolari.com)
//   SOLARI_BROWSER_URL   browser gateway (default = SOLARI_BASE_URL)
//   SESSION_IDLE_MS      evict MCP sessions idle longer than this (default 30 min)
//   MAX_SESSIONS         global cap on live MCP sessions (default 500)
//   MAX_SESSIONS_PER_KEY per-API-key cap (default 20)
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServerParts, closeAllVmSessions } from "./server.js";
import { releaseAllBrowserSessions } from "./browser.js";
const PORT = Number(process.env.PORT ?? 8080);
const IDLE_MS = Number(process.env.SESSION_IDLE_MS ?? 30 * 60 * 1000);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 500);
const MAX_PER_KEY = Number(process.env.MAX_SESSIONS_PER_KEY ?? 20);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DESKTOP_URL = process.env.SOLARI_BASE_URL ?? "https://api.getsolari.com";
const BROWSER_URL = process.env.SOLARI_BROWSER_URL ?? DESKTOP_URL;
const sessions = new Map();
const hash = (key) => createHash("sha256").update(key).digest("hex");
const countForKey = (h) => [...sessions.values()].filter((s) => s.keyHash === h).length;
// Cheap upfront key validation (the gateways are the real authority; this just
// gives a clean 401 at connect time instead of failures on the first tool
// call). Results are cached both ways and coalesced per key so a reconnect
// storm can't amplify into the prod auth path.
const keyCache = new Map();
const inflight = new Map();
async function probe(url, key) {
    try {
        const res = await fetch(url, {
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(5_000),
        });
        if (res.ok)
            return "ok";
        if (res.status === 401 || res.status === 403)
            return "reject";
        return "unknown";
    }
    catch {
        return "unknown";
    }
}
async function validateKey(key) {
    const h = hash(key);
    const hit = keyCache.get(h);
    if (hit && hit.until > Date.now())
        return hit.ok;
    const existing = inflight.get(h);
    if (existing)
        return existing;
    const p = (async () => {
        // Prod's browser and desktop gateways have separate key stores — a key is
        // acceptable if EITHER accepts it. Probe both concurrently.
        const [b, d] = await Promise.all([
            probe(`${BROWSER_URL}/profiles`, key),
            probe(`${DESKTOP_URL}/sandboxes?limit=1`, key),
        ]);
        if (b === "ok" || d === "ok") {
            keyCache.set(h, { ok: true, until: Date.now() + 60_000 });
            return true;
        }
        if (b === "reject" || d === "reject") {
            // Definitive no from a gateway that answered.
            keyCache.set(h, { ok: false, until: Date.now() + 30_000 });
            return false;
        }
        // Everything inconclusive (our blip, not the customer's fault): allow, but
        // don't cache, so we re-check on the next connect.
        return true;
    })().finally(() => inflight.delete(h));
    inflight.set(h, p);
    return p;
}
function bearer(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    return m?.[1];
}
function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
async function readBody(req) {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES)
        throw Object.assign(new Error("body too large"), { status: 413 });
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY_BYTES)
            throw Object.assign(new Error("body too large"), { status: 413 });
        chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw)
        return undefined;
    return JSON.parse(raw);
}
async function evict(id, why) {
    const s = sessions.get(id);
    if (!s)
        return;
    sessions.delete(id);
    // Actually RELEASE the customer's cloud resources. Browser sessions hold a
    // concurrency-limited pool slot until their hard TTL, and an open VM control
    // channel pins the VM "active" so it never idle-pauses — both bill until we
    // let go, and abandoning the MCP session is the normal end-of-conversation
    // path (models rarely call the close tools).
    await Promise.allSettled([
        releaseAllBrowserSessions(s.browserCfg, s.browserReg),
        closeAllVmSessions(s.vmReg),
    ]);
    try {
        await s.transport.close();
    }
    catch {
        /* already closed */
    }
    console.error(`mcp session ${id} evicted (${why})`);
}
const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions)
        if (now - s.lastSeen > IDLE_MS)
            void evict(id, "idle");
}, 60_000);
idleSweep.unref();
async function handleMcp(req, res) {
    const key = bearer(req);
    if (!key || !key.startsWith("slr_live_")) {
        json(res, 401, { error: "Authorization: Bearer slr_live_… required" });
        return;
    }
    const sid = req.headers["mcp-session-id"];
    if (sid) {
        const s = sessions.get(sid);
        if (!s) {
            json(res, 404, { error: "unknown mcp-session-id (session may have been evicted)" });
            return;
        }
        if (s.keyHash !== hash(key)) {
            json(res, 403, { error: "mcp-session-id belongs to a different API key" });
            return;
        }
        s.lastSeen = Date.now();
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await s.transport.handleRequest(req, res, body);
        return;
    }
    // No session id → must be a POST initialize.
    if (req.method !== "POST") {
        json(res, 400, { error: "mcp-session-id header required" });
        return;
    }
    if (!(await validateKey(key))) {
        json(res, 401, { error: "invalid Solari API key" });
        return;
    }
    const keyHash = hash(key);
    if (sessions.size >= MAX_SESSIONS) {
        json(res, 503, { error: "server at session capacity, retry shortly" });
        return;
    }
    if (countForKey(keyHash) >= MAX_PER_KEY) {
        json(res, 429, { error: `too many concurrent MCP sessions for this API key (max ${MAX_PER_KEY})` });
        return;
    }
    const body = await readBody(req);
    const parts = buildServerParts(undefined, { apiKey: key, baseUrl: BROWSER_URL });
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
            sessions.set(id, {
                transport,
                browserReg: parts.browserReg,
                browserCfg: parts.browserCfg,
                vmReg: parts.vmReg,
                keyHash,
                lastSeen: Date.now(),
            });
            console.error(`mcp session ${id} started (key ${keyHash.slice(0, 8)})`);
        },
        onsessionclosed: (id) => void evict(id, "client closed"),
    });
    await parts.server.connect(transport);
    await transport.handleRequest(req, res, body);
}
const httpServer = createServer((req, res) => {
    const url = req.url?.split("?")[0];
    if (url === "/health" || url === "/healthz") {
        json(res, 200, { ok: true, sessions: sessions.size });
        return;
    }
    if (url === "/mcp") {
        handleMcp(req, res).catch((err) => {
            const status = err.status ?? 500;
            if (status !== 413)
                console.error("mcp request failed:", err);
            if (!res.headersSent)
                json(res, status, { error: status === 413 ? "body too large" : "internal error" });
            else
                res.end();
        });
        return;
    }
    json(res, 404, { error: "not found (use /mcp)" });
});
// A stray rejection must never take down a task serving many tenants.
process.on("unhandledRejection", (err) => {
    console.error("solari-mcp: unhandled rejection (ignored):", err);
});
let shuttingDown = false;
async function shutdown(sig) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    console.error(`solari-mcp: ${sig} — draining ${sessions.size} session(s)`);
    httpServer.close();
    clearInterval(idleSweep);
    // Release every tenant's cloud resources; without this an ECS rollout leaks
    // one pool slot + one pinned VM per live conversation.
    await Promise.race([
        Promise.allSettled([...sessions.keys()].map((id) => evict(id, sig))),
        new Promise((r) => setTimeout(r, 20_000)),
    ]);
    process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => void shutdown(sig));
}
httpServer.listen(PORT, () => {
    console.error(`solari-mcp http listening on :${PORT} (browser gw ${BROWSER_URL}, desktop gw ${DESKTOP_URL})`);
});
