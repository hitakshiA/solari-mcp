# solari-mcp (solari-fast fork)

> **This is a fork of [`@solarisdk/mcp`](https://www.npmjs.com/package/@solarisdk/mcp) 0.5.0.** The first commit is the npm package exactly as published. Every commit after it is one of our changes, with its reason. Solari's original README follows the fork notes below, unchanged.

## What this fork adds

Agents driving Solari through this server had three ways to look at the screen: raw page text, raw HTML, or a screenshot. They acted by CSS selector or pixel coordinates. Every step cost a tool call to look, one to act, and another to look again. In practice, models gave up and wrote JavaScript for `solari_browser_evaluate`.

This fork adds a way to see and act that any MCP agent can use, including Codex, Claude and Cursor.

| Tool | What it does |
|---|---|
| `solari_browser_observe` | The page as numbered controls (`e7 button "Search"`) plus its visible text. It's small, stable, and cheap in tokens. |
| `solari_browser_act` | Acts on a control by its number (click, type, select, press or scroll) and **returns the fresh observation in the same call**. |
| `solari_desktop_observe` | The desktop's active window as numbered controls, read from the Linux accessibility tree. |
| `solari_desktop_act` | The same for desktops. |
| `solari_desktop_launch` | Starts an app with accessibility on, so the two tools above can read it. |

Two rules hold for every action:
- **Stale targets are refused.** Each act is re-checked against the observation it came from. If the control changed, moved under a dialog or disappeared, nothing is dispatched.
- **No coordinates from the model.** The model never supplies coordinates, selectors or script.

### Measured

Codex CLI with GPT-6 Astra, on the same task: open the Wikipedia article about Gödel's incompleteness theorems using the site's search, on a Solari browser.

| Server | Time | Tool calls | Input tokens |
|---|---|---|---|
| `@solarisdk/mcp` 0.5.0 as published | 81.7 s | 9 | 234k |
| This fork | **50.4 s** | 6 | 180k |

These are single runs, driven from Bengaluru against us-west. Codex chose the new tools on its own, without being prompted to.

### Changes, commit by commit

1. **`dist/fast.js` (new): observe and act.**
   - **Browsers:** the page is read in-page with the [solari-reflex](https://github.com/hitakshiA/solari-reflex) observer. It covers visible, enabled controls only, drops covered ones, and gives shared labels disambiguating context.
   - **Desktops:** the tree is read by `reflexd`. This small daemon is installed into the desktop on first use and turns the accessibility bus on (off in the stock image). It's reached over the desktop's preview URL, so each call is one HTTP request rather than one `exec`. It's sent gzipped because Solari's exec rejects request bodies over 16 KB.
2. **`dist/browser.js`:** registers `solari_browser_observe` and `solari_browser_act`. `solari_browser_type` no longer waits 20 ms per key; a 200-character field took 4 s to fill.
3. **`dist/server.js`:** registers `solari_desktop_observe`, `solari_desktop_act` and `solari_desktop_launch`.
4. **`dist/observe-source.js` and `scripts/sync-observer.mjs`:** the observer and daemon are generated from solari-reflex, so this server and the agent read screens identically. Regenerate them with `node scripts/sync-observer.mjs`.

All of Solari's existing tools are unchanged and keep working.

### Use it

Point your MCP client at this fork's `dist/cli.js` instead of `npx @solarisdk/mcp`. For example, with Codex:

```bash
codex -c 'mcp_servers.solari.command="node"' \
      -c 'mcp_servers.solari.args=["/path/to/solari-mcp/dist/cli.js"]' \
      -c 'mcp_servers.solari.env={SOLARI_API_KEY="slr_live_…"}'
```

---

## Solari's original README

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI
agents (Claude Desktop **incl. Cowork**, Claude Code, Cursor, Windsurf, …) use
**Solari as their browser, sandbox, and desktop**:

- **Cloud browser** — create stealth/proxied browser sessions, navigate, read
  pages, screenshot, click/type, session replay (wraps the Solari browser
  gateway + CDP via puppeteer-core).
- **Sandboxes** — headless microVMs: run commands/code, read/write files,
  expose ports.
- **Desktops** — GUI microVMs: screenshot/click/type, launch apps, noVNC
  stream URL.

MCP tool calls are stateless, so the server keeps an in-memory **session
registry**: `*_create` tools return a `sessionId`, and the rest take it.

## Use it — hosted connector (no install)

Point any MCP client at the hosted Streamable HTTP endpoint with your API key:

- **Prod:** `https://mcp.getsolari.com/mcp`
- **Staging:** currently NOT deployed — the us-east-1 ALB it rode was
  removed in the us-west-1 migration and its DNS record has been deleted.

Claude Desktop / claude.ai: **Settings → Connectors → Add custom connector**,
URL as above, and send `Authorization: Bearer slr_live_…`. Or in
`claude_desktop_config.json` / Claude Code:

```jsonc
{
  "mcpServers": {
    "solari": {
      "type": "http",
      "url": "https://mcp.getsolari.com/mcp",
      "headers": { "Authorization": "Bearer slr_live_…" }
    }
  }
}
```

Each MCP session is bound to the API key that initialized it; sessions idle
longer than 30 min are evicted server-side (your cloud sessions keep their own
lifecycles — re-attach with `solari_connect`).

## Use it — local stdio (Claude Desktop / Cowork / Cursor / Windsurf)

```jsonc
{
  "mcpServers": {
    "solari": {
      "command": "npx",
      "args": ["-y", "@solarisdk/mcp"],
      "env": { "SOLARI_API_KEY": "slr_live_…" }
    }
  }
}
```

## Use it — single-file bundle (no npm)

```jsonc
// claude_desktop_config.json (Claude Desktop: Developer → Edit Config)
{
  "mcpServers": {
    "solari": {
      "command": "node",
      "args": ["/absolute/path/to/solari-mcp.bundle.cjs"],
      "env": {
        "SOLARI_API_KEY": "slr_live_…"
        // optional overrides (defaults hit prod https://api.getsolari.com):
        // optional staging override — ONE host now serves both gateways:
        // "SOLARI_BASE_URL":    "https://api-sta.getsolari.com",
        // "SOLARI_BROWSER_URL": "https://api-sta.getsolari.com"
      }
    }
  }
}
```

Fully quit and reopen Claude Desktop after editing; the tools then show up in
Chat, Code and Cowork alike.

## Environment

| Var | Required | Default | Meaning |
|---|---|---|---|
| `SOLARI_API_KEY` | ✅ | — | unified `slr_live_…` key (works on both gateways) |
| `SOLARI_BASE_URL` | | `https://api.getsolari.com` | sandbox/desktop gateway |
| `SOLARI_BROWSER_URL` | | `SOLARI_BASE_URL` → prod | cloud-browser gateway. Both prod (`api.getsolari.com`) and staging (`api-sta.getsolari.com`) now path-route browser AND desktop on one host, so this rarely needs setting |
| `SOLARI_BROWSER_API_KEY` | | `SOLARI_API_KEY` | separate key for the browser gateway, for environments where the browser and desktop key stores are split |

## Tools

### Browser (Solari cloud browser)

| Tool | What it does |
|---|---|
| `solari_browser_create` | Start a browser session (`mode`, `proxy`, `captcha`, `recording`, `profileId`) → `{sessionId, mode, captcha}` |
| `solari_browser_navigate` | Go to a URL → `{url, title, status}` |
| `solari_browser_read_page` | Page text / links / HTML (30k-char cap) |
| `solari_browser_screenshot` | JPEG screenshot (image content) |
| `solari_browser_click` / `solari_browser_type` / `solari_browser_key` | Interact (selector or x/y) |
| `solari_browser_evaluate` | Run a JS expression on the page |
| `solari_browser_replay_url` | rrweb replay URL (needs `recording: true`) |
| `solari_browser_login` | Ask a HUMAN to sign in — returns a short-lived URL to show them |
| `solari_browser_await_login` | Wait for them to finish, then re-attach the session |
| `solari_browser_save_profile` | Persist the signed-in state to a profile (explicit — see below) |
| `solari_browser_close` | Release the session |

### Browser mode — stealth by default

`solari_browser_create` defaults to **`mode: "stealth"`** (the anti-bot hardened pool). A bare
call with no arguments gets it; the model does not have to ask.

This used to be an optional `stealth: true` boolean, and in practice models did not opt in — so
sessions quietly landed on the fast pool and got blocked by bot detection. The failure looked
like "the site is broken" rather than "we chose the wrong pool", which is the worst way for a
default to be wrong.

`mode: "fast"` is the explicit opt-out: lower latency, for sites you already know do not
fingerprint or block automation (internal tools, localhost, your own app, plain docs). If a page
returns a block/captcha/challenge in fast mode, close the session and retry on stealth.

`proxy` and `captcha` are stealth-only upstream and are now **rejected** in fast mode rather than
silently dropped — a quietly unproxied request leaks the origin IP, which is the one thing the
caller was trying to avoid. The response echoes the resolved `mode`, so a later block is
actionable.

The deprecated `stealth` boolean still works in both directions for existing callers
(`stealth: false` still means fast); an explicit `mode` wins when both are supplied.

**Captcha auto-solving is on by default too**, for the same reason: an option a model has to opt
into does not get used, and the resulting failure ("the page is a challenge screen") reads as a
broken site rather than a missing flag. Pass **`captcha: false`** to opt out — solving costs money
and adds latency, so turn it off for sites you know never challenge.

The default *follows the pool* rather than being a flat `true`: captcha is stealth-only upstream,
so a flat default would make a plain `mode: "fast"` call throw on an option the caller never
asked for. Stealth ⇒ on, fast ⇒ off, explicit value always wins. Asking for `captcha: true`
*together with* `mode: "fast"` is a real contradiction and is refused. The response echoes the
resolved `captcha` alongside `mode`.

### Login handoff — the agent never touches a password

When a session hits a login form or 2FA prompt, the agent calls
`solari_browser_login` and shows the returned URL to the user. They open it, get
a **live view of the exact page the agent is on**, and type their credentials
directly into it. The agent then calls `solari_browser_await_login` and carries
on where it left off — same page, now signed in.

**The agent is locked out for the duration.** The gateway refuses its CDP
upgrades *and* severs the socket it already holds, so it cannot watch the typing
even though it is mid-session. That is enforced at the proxy, not here: a check
in this layer would be advisory, because the agent speaks raw CDP.

Two consequences worth knowing:

- Other browser tools on that session fail while a handoff is open. That is the
  freeze working, not a bug.
- `await_login` **reconnects** on success. The sever kills the stored puppeteer
  handle, so resuming needs a fresh dial; without it the agent would "resume"
  into a Target-closed error.

The link lives 5 minutes and is single-use. If it lapses, call
`solari_browser_login` again — the session is untouched.

**Saving the login for next time is explicit.** `solari_browser_save_profile`
captures the session's cookies + localStorage into a profile, and future runs
skip the human entirely via `create({profileId})`. It is deliberately *not*
automatic: those are live session cookies, which bypass 2FA, so the profile is a
credential store and should exist because the user chose it. The tool reports the
cookie count and origins it stored, so they can see what was persisted.

### Sandboxes + desktops

| Tool | What it does |
|---|---|
| `solari_sandbox_create` | Create a headless sandbox → `sessionId` |
| `solari_desktop_create` | Create a GUI desktop → `sessionId` + `streamUrl` |
| `solari_list` | List the org's VMs — **both** sandboxes and desktops, each labelled with its `kind` (optional `kind`/`state` filters) |
| `solari_kill` | Destroy a session |
| `solari_connect` | Re-attach to a session by id across restarts (auto-resumes if paused) |
| `solari_exec` | Run a shell command (via `sh -c`) → `{stdout,stderr,exitCode}` |
| `solari_run_command_bg` | Start a background shell command → `{cmdId}` |
| `solari_run_code` | Run code (default Python) → results incl. structured charts |
| `solari_read_file` / `solari_write_file` / `solari_list_files` | Guest filesystem |
| `solari_get_preview_url` | Public preview URL for an in-guest port |
| `solari_screenshot` | Capture the desktop as a PNG (image content) |
| `solari_click` / `solari_type` / `solari_key` | Desktop mouse/keyboard |
| `solari_open_app` | Launch an app on the desktop |

(The desktop GUI tools require a `solari_desktop_create` session; they error on
a sandbox. The browser tools are independent of both.)

## Develop

```bash
npm install          # installs @modelcontextprotocol/sdk, puppeteer-core + the local SDK
npm run build        # tsc → dist/
npm test             # mock-client toolset tests (no network)
npm run build:bundle # esbuild → dist/solari-mcp.bundle.cjs (single file, no node_modules)
```

**Live smoke (manual, hits real pools):**

```bash
SOLARI_API_KEY=slr_live_… \
SOLARI_BASE_URL=https://api-sta.getsolari.com \
SOLARI_BROWSER_URL=https://api-sta.getsolari.com \
node test/live-smoke.mjs            # add SMOKE_SERVER=dist/solari-mcp.bundle.cjs to test the bundle
```

Round-trips browser create→navigate→read→screenshot→search→close, sandbox
create→exec→run_code→kill, and desktop create→screenshot→kill as a real MCP
client over stdio.

## Hosted connector — where it runs (ops)

All of this is **manual**, not terraform.

| | Prod | Staging |
|---|---|---|
| URL | `https://mcp.getsolari.com/mcp` | *(not deployed — see above)* |
| Region | **us-west-1** | — |
| Cluster | `solari-desktops-prod-usw1-gw` | — |
| Service / taskdef | `solari-mcp-prod-usw1` | — |
| Image | ECR `solari-mcp:prod` (us-west-1) | — |
| Ingress | listener rule **prio 20** on the gateway ALB, host-header match | — |

It rides the desktop gateway's ALB, so it is **coupled to that ALB's lifetime**.

### ⚠️ `/health` returning 200 does NOT mean the connector is up

The desktop gateway answers `GET /health` with `{"ok":true}` too. If DNS points at the
gateway instead of the connector — which is exactly what happened on 2026-07-28, when the
us-west-1 migration deleted the old us-east-1 gateway ALB and re-aliased
`mcp.getsolari.com` to the new one — `/health` still returns 200 while **every MCP call
404s**. The connector was down and the health check was green.

Two checks that actually discriminate:

```sh
curl -s https://mcp.getsolari.com/health      # connector's body has a "sessions" field; the gateway's does not
curl -s -o /dev/null -w '%{http_code}\n' -XPOST https://mcp.getsolari.com/mcp \
     -H 'content-type: application/json' -d '{}'
#   401 = the connector (auth required)   404 = the gateway is answering — connector NOT reachable
```

**If you move or rebuild the desktop gateway ALB, you must re-point this service too** —
target group, listener rule, and the Route53 alias all live on that ALB.
