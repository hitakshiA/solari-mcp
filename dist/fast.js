// Fast observe/act for solari-mcp (added in the solari-fast fork).
//
// Why: an agent driving a browser or desktop through this server used to choose
// between raw page text, raw HTML, or a screenshot, and then act by CSS
// selector or pixel coordinates — one tool call to look, one to act, and
// another to look again. In practice models fell back to writing JavaScript
// for solari_browser_evaluate. These tools give every agent (Codex, Claude,
// anything MCP) the same view the solari-reflex agent uses:
//
//   *_observe  the screen as numbered controls ("e7 button \"Search\"") plus
//              the visible text: small, stable, and cheap in tokens;
//   *_act      act on a control by its number and return the fresh
//              observation in the same call, so look–act–look is one call.
//
// Every act re-checks the control against the observation it came from and
// refuses (nothing is dispatched) when it changed, moved under a dialog or
// disappeared. Browsers are read in-page with the solari-reflex observer;
// desktops are read from the Linux accessibility tree by reflexd, which this
// module installs into the desktop on first use.
import { INSTALL_OBSERVER, OBSERVER_VERSION, REFLEXD_GZ_B64 } from "./observe-source.js";

export const OBSERVE_LIMITS = { maxElements: 120, maxTextChars: 3000 };
const REFLEXD_PORT = 7788;

// ------------------------------------------------------------- formatting --

/** The compact form an LLM reads: one line per control, then the visible text. */
export function formatObservation(o, { textChars = 1500 } = {}) {
    const lines = o.elements.map((e) => {
        const parts = [`${e.id} ${e.role} ${JSON.stringify(e.name)}`];
        if (e.value) parts.push(`value=${JSON.stringify(e.value)}`);
        for (const k of ["checked", "selected", "expanded"]) if (e[k] !== undefined) parts.push(`${k}=${e[k]}`);
        if (e.context) parts.push(`in ${JSON.stringify(e.context)}`);
        if (e.options?.length) parts.push(`options=${JSON.stringify(e.options.map((x) => x.label).slice(0, 20))}`);
        if (o.focused === e.id) parts.push("[focused]");
        return parts.join(" ");
    });
    return [
        `url: ${o.url}`,
        `title: ${o.title}`,
        `controls (${o.elements.length}${o.omitted ? `, ${o.omitted} more below the cap` : ""}):`,
        ...lines,
        "",
        `visible text:`,
        o.text.slice(0, textChars),
    ].join("\n");
}

// ---------------------------------------------------------------- browser --

const call = (body) => `window.__reflex?.version === ${OBSERVER_VERSION} ? ((r) => ${body})(window.__reflex) : "__missing__"`;

async function inPage(page, body, awaitPromise = false) {
    let v = await page.evaluate(awaitPromise ? `(async () => ${call(body)})()` : call(body));
    if (v === "__missing__") {
        await page.evaluate(INSTALL_OBSERVER);
        v = await page.evaluate(awaitPromise ? `(async () => ${call(body)})()` : call(body));
    }
    return v;
}

export async function browserObserve(page) {
    for (let i = 0; i < 20; i++) {
        const o = await inPage(page, `r.observe(${JSON.stringify(OBSERVE_LIMITS)})`).catch(() => null);
        if (o) return o;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the page kept changing and could not be observed");
}

/**
 * Act on a control from the last observation, then return the fresh one.
 * action: "click" | "type" | "select" | "press" | "scroll"
 */
export async function browserAct(page, last, a) {
    if (a.action === "press") {
        await page.keyboard.press(a.key ?? "Enter");
    } else if (a.action === "scroll") {
        await page.mouse.wheel({ deltaY: (a.direction === "up" ? -1 : 1) * 560 });
    } else {
        const el = resolve(last, a.ref);
        const expected = JSON.stringify(last.guards[el.node] ?? null);
        if (a.action === "select") {
            const ok = await inPage(page, `r.guard(${el.node}) !== ${expected} ? false : r.choose(${el.node}, ${JSON.stringify(a.value ?? "")})`);
            if (!ok) throw new Error(`${a.ref} changed, or has no option ${JSON.stringify(a.value)}; observe again`);
        } else {
            const at = await inPage(page, `r.guard(${el.node}) !== ${expected} ? "stale" : r.locate(${el.node}, ${el.editable})`);
            if (at === "stale") throw new Error(`${a.ref} (${el.name}) changed since it was observed; observe again`);
            if (!at) throw new Error(`${a.ref} (${el.name}) is covered, disabled or gone; observe again`);
            await page.mouse.click(at.x, at.y);
            if (a.action === "type") {
                await page.keyboard.down("Control");
                await page.keyboard.press("a");
                await page.keyboard.up("Control");
                // Insert the whole value at once rather than one key every 20 ms.
                await page.keyboard.sendCharacter(a.text ?? "");
                if (a.submit) await page.keyboard.press("Enter");
            }
        }
        await inPage(page, `r.settle(${a.action === "type" ? el.node : null}, 250)`, true).catch(() => undefined);
    }
    await page.waitForFunction(() => document.readyState !== "loading", { timeout: 10_000 }).catch(() => undefined);
    return browserObserve(page);
}

function resolve(last, ref) {
    if (!last) throw new Error("observe first: call the *_observe tool, then act on a control by its id");
    const el = last.elements.find((e) => e.id === ref);
    if (!el) throw new Error(`unknown control ${ref}; observe again`);
    return el;
}

// ---------------------------------------------------------------- desktop --

const INSTALL_REFLEXD = (token) => `set -e
export DEBIAN_FRONTEND=noninteractive
if ! python3 -c 'import gi; gi.require_version("Atspi","2.0")' 2>/dev/null; then
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq --no-install-recommends at-spi2-core python3-gi gir1.2-atspi-2.0 libatk-adaptor imagemagick >/dev/null 2>&1
fi
mkdir -p /opt/reflex
echo '${REFLEXD_GZ_B64}' | base64 -d | gunzip > /opt/reflex/reflexd.py
# A fresh desktop may still be starting its session; wait for it rather than fail silently.
for i in $(seq 1 60); do P=$(pgrep -x xfce4-session | head -1 || true); [ -n "$P" ] && break; sleep 0.5; done
[ -n "$P" ] || { echo "no desktop session (xfce4-session) is running"; exit 1; }
ps -o user= -p "$P" | tr -d ' ' > /opt/reflex/user
tr '\\0' '\\n' < /proc/$P/environ | grep -E '^(DBUS_SESSION_BUS_ADDRESS|DISPLAY|XDG_RUNTIME_DIR|HOME|XAUTHORITY)=' > /opt/reflex/session.env
cat > /opt/reflex/start.sh <<'SH'
set -a; . /opt/reflex/session.env; set +a
gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null || true
pgrep -u "$(id -un)" -f at-spi-bus-launcher >/dev/null || setsid -f /usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 </dev/null
sleep 0.5
pkill -u "$(id -un)" -f "reflex/reflexd.py" || true
REFLEXD_TOKEN="$1" setsid -f python3 /opt/reflex/reflexd.py >/opt/reflex/reflexd.log 2>&1 </dev/null
SH
cat > /opt/reflex/launch.sh <<'SH'
set -a; . /opt/reflex/session.env; set +a
export NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge SAL_USE_VCLPLUGIN=gtk3 GNOME_ACCESSIBILITY=1
setsid -f "$@" >/dev/null 2>&1 </dev/null
SH
chown -R "$(cat /opt/reflex/user)" /opt/reflex
runuser -u "$(cat /opt/reflex/user)" -- bash /opt/reflex/start.sh '${token}'
for i in $(seq 1 50); do curl -sf http://127.0.0.1:${REFLEXD_PORT}/health >/dev/null && { echo "reflexd ready"; exit 0; }; sleep 0.2; done
echo "reflexd not ready"; tail -5 /opt/reflex/reflexd.log; exit 1`;

/** Install and start reflexd in a desktop session entry once; cache how to reach it on the entry. */
export async function ensureReflexd(e) {
    if (e.reflexd) return e.reflexd;
    const token = crypto.randomUUID().replaceAll("-", "");
    const r = await e.handle.commands.run("bash", { args: ["-c", INSTALL_REFLEXD(token)] });
    if (!String(r.stdout ?? "").includes("reflexd ready")) {
        throw new Error(`could not start the desktop observer: ${String(r.stderr || r.stdout).slice(-300)}`);
    }
    const preview = await e.handle.previewUrl(REFLEXD_PORT);
    e.reflexd = { url: String(preview?.url ?? preview), token };
    return e.reflexd;
}

async function reflexd(e, path, body) {
    const d = await ensureReflexd(e);
    // Preview URLs carry their token in the query string; set the path on the parsed URL.
    const u = new URL(d.url);
    u.pathname = path;
    const r = await fetch(u, {
        method: "POST",
        headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
    });
    const j = await r.json();
    if (j.error) throw new Error(`desktop observer ${path}: ${j.error}`);
    return j.result;
}

export async function desktopObserve(e) {
    for (let i = 0; i < 10; i++) {
        const o = await reflexd(e, "/observe", { max_elements: OBSERVE_LIMITS.maxElements, max_text_chars: OBSERVE_LIMITS.maxTextChars });
        if (o) return o;
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("no window is active on the desktop");
}

export async function desktopAct(e, last, a) {
    const el = a.action === "press" || a.action === "scroll" ? undefined : resolve(last, a.ref);
    const kind = a.action;
    const r = await reflexd(e, "/act", {
        action: {
            kind,
            ...(el ? { node: el.node } : {}),
            ...(kind === "type" ? { text: a.text ?? "", ...(a.submit ? { submit: true } : {}) } : {}),
            ...(kind === "select" ? { value: a.value ?? "" } : {}),
            ...(kind === "press" ? { key: a.key ?? "Enter" } : {}),
            ...(kind === "scroll" ? { direction: a.direction ?? "down" } : {}),
        },
        guard: el ? last.guards[el.node] ?? null : null,
    });
    if (r?.error) throw new Error(`${a.ref ?? kind}: ${r.error}; observe again`);
    return desktopObserve(e);
}

/** Launch an app with the accessibility bridge on, as the desktop user. */
export async function desktopLaunch(e, name, args = []) {
    await ensureReflexd(e);
    const quoted = [name, ...args].map((s) => `'${String(s).replaceAll("'", "'\\''")}'`).join(" ");
    await e.handle.commands.run("bash", { args: ["-c", `runuser -u "$(cat /opt/reflex/user)" -- bash /opt/reflex/launch.sh ${quoted}`] });
}
