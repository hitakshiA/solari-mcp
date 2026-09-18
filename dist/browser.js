// Solari cloud-browser toolset for solari-mcp.
//
// The browser gateway is a session control plane only (create/release); all
// page-level actions here are driven client-side over the session's raw CDP
// endpoint via puppeteer-core. We keep the connected Browser handle for the
// session's lifetime — the signed ws URL cannot be re-dialed after 90 minutes.
import puppeteer from "puppeteer-core";
import { z } from "zod";
import { browserAct, browserObserve, formatObservation } from "./fast.js";
const text = (o) => ({
    content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }],
});
const MAX_PAGE_TEXT = 30_000;
const MAX_LINKS = 200;
const CDP_DIAL_ATTEMPTS = 3;
/** How often await_login re-checks handoff status. */
const HANDOFF_POLL_MS = 2_000;
/** Signed ws/wss capability URLs must never reach the model or a log. */
const redact = (s) => s.replace(/wss?:\/\/[^\s"']+/gi, "[redacted-ws-url]");
async function api(cfg, method, path, body) {
    // Session create can block up to 60s gateway-side waiting for a slot.
    const res = await fetch(`${cfg.baseUrl}${path}`, {
        method,
        headers: {
            authorization: `Bearer ${cfg.apiKey}`,
            ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(90_000),
    });
    return res;
}
/**
 * Turn a gateway error into a model-safe message: only the documented
 * {code,message} fields, never the raw body (which on a 2xx-shaped response
 * carries the session's bearer-capability ws URLs).
 */
async function apiError(res, what) {
    let detail = "";
    try {
        const raw = await res.text();
        try {
            const j = JSON.parse(raw);
            detail = [j.code, j.error ?? j.message].filter(Boolean).join(": ");
        }
        catch {
            detail = redact(raw).slice(0, 200);
        }
    }
    catch {
        /* body unavailable */
    }
    throw new Error(`${what} failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
}
/** Release a browser session gateway-side. Safe to call for unknown ids. */
export async function releaseBrowserSession(cfg, id, fetchApi = api) {
    const api_ = fetchApi;
    // Gateway bearer verification can transiently 401 (control-plane verify blip
    // / auth-cache churn) and a failed release leaks the pool slot until TTL, so
    // retry transient statuses before giving up.
    let res = await api_(cfg, "DELETE", `/sessions/${encodeURIComponent(id)}`);
    for (let i = 0; i < 2 && (res.status === 401 || res.status === 429 || res.status >= 500); i++) {
        await new Promise((r) => setTimeout(r, 1500));
        res = await api_(cfg, "DELETE", `/sessions/${encodeURIComponent(id)}`);
    }
    if (res.status === 404) {
        // Bare 404 = already gone (fine). 404 + InvalidSessionId = the gateway
        // refused the id and released NOTHING.
        let code;
        try {
            code = (await res.json()).code;
        }
        catch {
            /* no body */
        }
        if (code === "InvalidSessionId") {
            throw new Error(`release failed: gateway rejected sessionId (session may still be live)`);
        }
        return;
    }
    if (res.status !== 204 && !res.ok)
        await apiError(res, "session release");
}
const defaultDeps = {
    connect: (cdpEndpoint) => puppeteer.connect({
        browserWSEndpoint: cdpEndpoint,
        // null = adopt the pool browser's real window. Forcing a viewport here
        // applies an Emulation override, which makes window/screen metrics
        // inconsistent and weakens stealth sessions.
        defaultViewport: null,
    }),
    fetchApi: api,
};
export function makeBrowserToolset(cfg, reg, deps = defaultDeps) {
    const api = deps.fetchApi;
    const need = (id) => {
        const e = reg.sessions.get(id);
        if (!e)
            throw new Error(`unknown browser sessionId: ${id} (create one with solari_browser_create)`);
        // The signed CDP URL is not re-dialable after the session expires, so say
        // so plainly instead of surfacing a raw "Target closed".
        if (e.expiresAt && Date.parse(e.expiresAt) <= Date.now()) {
            reg.sessions.delete(id);
            throw new Error(`browser session ${id} expired at ${e.expiresAt}; create a new one with solari_browser_create`);
        }
        return e;
    };
    // Act on the newest attached, non-blank page so a click that opened a tab or
    // popup is followed rather than silently ignored.
    const activePage = async (e) => {
        let pages = [];
        try {
            pages = await e.browser.pages();
        }
        catch {
            /* browser gone; fall through to the cached page */
        }
        const usable = pages.filter((p) => !p.isClosed());
        if (usable.length === 0) {
            if (!e.page.isClosed())
                return e.page;
            throw new Error("no open pages in this browser session");
        }
        const named = usable.filter((p) => {
            const u = p.url();
            return u && u !== "about:blank";
        });
        e.page = (named.length ? named : usable)[named.length ? named.length - 1 : usable.length - 1];
        return e.page;
    };
    const capText = (s, what) => s.length > MAX_PAGE_TEXT
        ? `${s.slice(0, MAX_PAGE_TEXT)}\n…[truncated ${s.length - MAX_PAGE_TEXT} of ${s.length} ${what}]`
        : s;
    return {
        solari_browser_create: {
            description: "Start a Solari cloud browser session. Use this whenever you need to browse the web. " +
                "Returns a sessionId for the other solari_browser_* tools.\n" +
                "mode defaults to 'stealth' — the anti-bot hardened pool. Just call this with no " +
                "arguments and you get it; you do NOT need to ask for stealth explicitly. Stealth is " +
                "the right default for the open web: ordinary sites work fine on it, and it is what " +
                "keeps bot-detection from blocking the session.\n" +
                "Pass mode:'fast' ONLY for a site you already know does not fingerprint or block " +
                "automation (internal tools, localhost, your own app, plain docs/API pages) and you " +
                "want the lower-latency pool. If a page in fast mode returns a block/captcha/challenge, " +
                "close the session and retry with mode:'stealth'.\n" +
                "captcha auto-solving is ALSO on by default (it follows the pool: on for stealth, off " +
                "for fast). Pass captcha:false to turn it off — solving a challenge costs money and " +
                "adds latency, so switch it off for sites you know never challenge.\n" +
                "proxy ('smart' | country code like 'us') REQUIRES stealth, as does captcha; both are " +
                "rejected if you ask for them explicitly in fast mode. recording gives an rrweb replay.",
            inputSchema: {
                mode: z.enum(["stealth", "fast"]).optional(),
                /** @deprecated use mode. Kept so existing callers keep working. */
                stealth: z.boolean().optional(),
                proxy: z.string().optional(),
                /** Defaults to ON (following the pool). Pass false to opt out. */
                captcha: z.boolean().optional(),
                recording: z.boolean().optional(),
                profileId: z.string().optional(),
                /** Defaults to ON. Pass false to never auto-sign-in on this session. */
                autoLogin: z.boolean().optional(),
            },
            handler: async (a) => {
                // STEALTH IS THE DEFAULT. Models consistently declined to opt in when it
                // was an optional boolean, so sessions silently landed on the fast pool
                // and got blocked by bot detection — the failure looked like "the site
                // is broken" rather than "we picked the wrong pool". Defaulting on, with
                // an explicit escape hatch, removes that whole class of confusion.
                //
                // Precedence: explicit mode wins; then the deprecated stealth boolean
                // (so `stealth:false` still means fast for old callers); then stealth.
                const stealth = a.mode !== undefined ? a.mode === "stealth" : (a.stealth ?? true);
                // CAPTCHA IS ALSO ON BY DEFAULT — same reasoning as stealth: a model
                // that has to opt in does not, and the resulting failure ("the page is
                // a challenge screen") reads as a broken site rather than a missing
                // option.
                //
                // The default FOLLOWS the pool rather than being a flat `true`, because
                // captcha is stealth-only upstream. A flat true would make plain
                // mode:'fast' throw on an option the caller never asked for, turning the
                // escape hatch into a dead end. So: stealth ⇒ on, fast ⇒ off, and an
                // explicit value always wins (captcha:false is the opt-out).
                const captcha = a.captcha ?? stealth;
                // proxy/captcha are stealth-only upstream. Previously a fast-pool
                // session with proxy came back with the proxy silently dropped and only
                // a note in the response; fail loudly instead — a silently unproxied
                // request can leak the origin IP, which is the one thing the caller was
                // trying to avoid. Only an EXPLICIT ask conflicts; the captcha default
                // simply turns itself off in fast mode.
                if (!stealth) {
                    const needsStealth = [a.proxy ? "proxy" : "", a.captcha === true ? "captcha" : ""].filter(Boolean);
                    if (needsStealth.length) {
                        throw new Error(`${needsStealth.join(" and ")} ${needsStealth.length > 1 ? "require" : "requires"} ` +
                            `stealth, but mode is 'fast'. ` +
                            `Drop ${needsStealth.length > 1 ? "them" : "it"} or use mode:'stealth'.`);
                    }
                }
                const body = {};
                if (stealth)
                    body.stealth = true;
                if (captcha)
                    body.captcha = true;
                if (a.recording)
                    body.recording = true;
                if (a.proxy)
                    body.proxy = a.proxy;
                if (a.profileId)
                    body.profileId = a.profileId;
                // Auto-login is ON by default. If the account has connected a password
                // manager and configured this site, the gateway signs the session in on
                // its own — the agent never sees or handles the credential. Costs
                // nothing when nothing is configured: the gateway finds no connection
                // and the flow is exactly as before.
                if (a.autoLogin !== false)
                    body.autoLogin = true;
                const res = await api(cfg, "POST", "/sessions", body);
                if (res.status !== 201)
                    await apiError(res, "session create");
                const s = (await res.json());
                // cdpEndpoint is optional on the wire; derive it from wsEndpoint the
                // way the official SDK does.
                const cdp = s.cdpEndpoint ?? s.wsEndpoint?.replace("/ws/", "/cdp/");
                if (!cdp)
                    throw new Error("gateway returned no cdpEndpoint or wsEndpoint");
                // From here on the session is BILLABLE. Any failure before it is
                // registered must release it, or it leaks until TTL with an id the
                // model never saw.
                try {
                    let browser;
                    let lastErr;
                    for (let i = 0; i < CDP_DIAL_ATTEMPTS; i++) {
                        try {
                            browser = await deps.connect(cdp);
                            break;
                        }
                        catch (err) {
                            // A freshly-started session has a transient upstream window.
                            lastErr = err;
                            await new Promise((r) => setTimeout(r, 500 * (i + 1)));
                        }
                    }
                    if (!browser)
                        throw lastErr ?? new Error("could not connect to the browser");
                    const pages = await browser.pages();
                    const page = pages.find((p) => !p.isClosed()) ?? (await browser.newPage());
                    reg.sessions.set(s.sessionId, {
                        sessionId: s.sessionId,
                        browser,
                        page,
                        expiresAt: s.expiresAt,
                        recording: Boolean(a.recording),
                        cdpEndpoint: cdp,
                    });
                }
                catch (err) {
                    await releaseBrowserSession(cfg, s.sessionId, api).catch(() => { });
                    throw new Error(`browser session started but could not be attached (released it): ${redact(err instanceof Error ? err.message : String(err))}`);
                }
                // Proxy silently degrades rather than erroring — surface what we got.
                // Echo the resolved mode back: the caller did not necessarily pick it
                // (stealth is the default), and knowing which pool it landed on is what
                // makes a later block actionable — "retry on stealth" vs "this site
                // blocks us even hardened".
                return text({
                    sessionId: s.sessionId,
                    mode: stealth ? "stealth" : "fast",
                    captcha,
                    expiresAt: s.expiresAt,
                    proxy: s.proxy ?? (a.proxy ? "NOT APPLIED (check plan)" : undefined),
                });
            },
        },
        solari_browser_profiles: {
            description: "List saved browser profiles for this account. A profile is a stored signed-in state " +
                "(cookies + localStorage) that solari_browser_create({profileId}) replays, so the " +
                "session starts already logged in.\n" +
                "Check here FIRST when a task will need a login: if a profile for that site already " +
                "exists, use it and no human is involved at all. `version` is 1 and `populated` is " +
                "false for a profile nobody has signed into yet — that one still needs " +
                "solari_browser_login({profileName}).",
            inputSchema: {},
            handler: async () => {
                const res = await api(cfg, "GET", "/profiles");
                if (res.status !== 200)
                    await apiError(res, "list profiles");
                const rows = (await res.json());
                return text({
                    profiles: rows.map((p) => ({
                        profileId: p.id,
                        name: p.name,
                        version: p.version,
                        populated: Boolean(p.storageStateS3Key),
                        lastUsedAt: p.lastUsedAt ?? null,
                    })),
                });
            },
        },
        solari_browser_autologin_status: {
            description: "Check whether this account can sign in to websites automatically, and get a direct " +
                "setup link if it cannot.\n" +
                "Call this when a task will clearly need a login, BEFORE you start — if nothing is set " +
                "up you can tell the user once, up front, with a link, instead of interrupting them " +
                "mid-run. Also worth calling if a login keeps needing a human.\n" +
                "Returns the connected password managers, the sites already configured, and `setupUrl`. " +
                "If `configured` is false, SHOW setupUrl TO THE USER: it opens the page where they " +
                "connect a password manager. You cannot do that step for them — it needs a credential " +
                "that must never pass through you — but the link removes all the guesswork.",
            inputSchema: {},
            handler: async () => {
                const res = await api(cfg, "GET", "/vault/status");
                if (res.status === 501) {
                    return text({
                        configured: false,
                        available: false,
                        note: "Automatic sign-in is not available on this deployment.",
                    });
                }
                if (res.status !== 200)
                    await apiError(res, "auto-login status");
                const d = (await res.json());
                const managers = d.managers ?? [];
                const sites = d.sites ?? [];
                return text({
                    configured: managers.length > 0,
                    available: true,
                    managers: managers.map((m) => ({ name: m.name, provider: m.provider, vaults: m.vaults })),
                    sites,
                    setupUrl: d.setupUrl ?? null,
                    next: managers.length === 0
                        ? "No password manager is connected. Show setupUrl to the user — it takes them " +
                            "straight to the page where they connect one, after which logins happen with no " +
                            "human involved."
                        : sites.length === 0
                            ? "A password manager is connected but no sites use it yet. Add one with " +
                                "solari_browser_autologin_site, or the user can do it at setupUrl."
                            : "Automatic sign-in is set up. Sessions will log in to these sites on their own.",
                });
            },
        },
        solari_browser_autologin_site: {
            description: "Tell Solari to sign in to a site automatically using a connected password manager.\n" +
                "`domain` is the site, e.g. 'github.com'. `manager` is the NAME of a connected password " +
                "manager (see solari_browser_autologin_status) — omit it to mean 'remember the session " +
                "but ask a human for a fresh login'. `item` is an optional 'Vault/Item' path for when " +
                "one site has several logins; omit it to match by site.\n" +
                "This only says WHICH credential to use — it never handles the credential itself.",
            inputSchema: {
                domain: z.string(),
                manager: z.string().optional(),
                item: z.string().optional(),
            },
            handler: async (a) => {
                const res = await api(cfg, "POST", "/vault/sites", {
                    domain: a.domain,
                    ...(typeof a.manager === "string" ? { manager: a.manager } : {}),
                    ...(typeof a.item === "string" ? { item: a.item } : {}),
                });
                if (res.status !== 200)
                    await apiError(res, "configure auto-login site");
                const d = (await res.json());
                return text({
                    ...d,
                    next: "Set. The next session that hits a login wall on this site signs in automatically " +
                        "if the credential is found; otherwise a human is asked, as before.",
                });
            },
        },
        solari_browser_login: {
            description: "Get this session signed in. Call it the moment you hit a login form, a 2FA prompt, or "
                + "anything asking for a password — you must never handle credentials yourself.\n"
                + "It tries the account's connected password manager FIRST: if one is set up for this "
                + "site, you are signed in automatically and NO human is involved — the reply says "
                + 'signedIn:true and you simply carry on. Otherwise it falls back to asking a human.\n'
                + "Two ways to call it:\n" +
                "HOT — pass `sessionId` when you are ALREADY on a login wall mid-task. The user gets a " +
                "live view of the exact page you are on and types into it; you resume on that same page.\n" +
                "COLD — pass `profileName` when you know a task will need a login and no session is open " +
                "yet. The user signs in once in a profile editor, and every later " +
                "solari_browser_create({profileId}) starts already authenticated. Prefer this when you " +
                "can: nobody has to be watching mid-run. The profile is created if it does not exist.\n" +
                "Pass exactly one of the two. Either way, SHOW THE RETURNED URL TO THE USER, then call " +
                "solari_browser_await_login.\n" +
                "In the HOT case your access to that session is REVOKED while the handoff is open — " +
                "deliberately, so you cannot observe what they type — and the link expires in 5 minutes. " +
                "Cold links last longer and revoke nothing, because there is no session yet.\n" +
                "`reason` is required and is shown to the user — say plainly which site is asking and " +
                "what for, because they are being asked to type a password on your say-so.",
            inputSchema: {
                sessionId: z.string().optional(),
                profileName: z.string().optional(),
                reason: z.string(),
            },
            handler: async (a) => {
                const sessionId = typeof a.sessionId === "string" ? a.sessionId : "";
                const profileName = typeof a.profileName === "string" ? a.profileName.trim() : "";
                if (Boolean(sessionId) === Boolean(profileName)) {
                    throw new Error("Pass exactly one of sessionId (rescue a live session) or profileName (seed a " +
                        "profile before you start).");
                }
                // ── COLD: seed a profile, no session involved ────────────────────
                if (profileName) {
                    const listRes = await api(cfg, "GET", "/profiles");
                    if (listRes.status !== 200)
                        await apiError(listRes, "list profiles");
                    const rows = (await listRes.json());
                    const match = rows.find((p) => (p.name ?? "").toLowerCase() === profileName.toLowerCase());
                    let profileId = match?.id ?? "";
                    if (!profileId) {
                        const mk = await api(cfg, "POST", "/profiles", { name: profileName });
                        if (mk.status !== 200 && mk.status !== 201)
                            await apiError(mk, "create profile");
                        profileId = (await mk.json()).id ?? "";
                        if (!profileId)
                            throw new Error("profile created but no id returned");
                    }
                    const hRes = await api(cfg, "POST", `/profiles/${encodeURIComponent(profileId)}/login-handoff`, {
                        reason: a.reason,
                    });
                    if (hRes.status !== 200)
                        await apiError(hRes, "cold login request");
                    const h = (await hRes.json());
                    return text({
                        mode: "cold",
                        profileId,
                        profileName,
                        handoffId: h.handoffId,
                        url: h.url,
                        expiresAt: h.expiresAt,
                        // Echoed so await_login can tell a fresh save from the state it
                        // started in — the version bump IS the completion signal.
                        sinceVersion: h.version,
                        next: `Show the url to the user, then call solari_browser_await_login({ profileId: ` +
                            `"${profileId}", sinceVersion: ${h.version} }).`,
                    });
                }
                // ── HOT: rescue the live session ─────────────────────────────────
                const e = need(sessionId);
                // Try the account's password manager FIRST. If a vault is connected and
                // this site is configured, the gateway signs in on its own and no human
                // is involved at all — we never see the credential either way. Only
                // escalate to a human when that cannot work. Best-effort: any failure
                // here just falls through to the handoff below, which is the behaviour
                // that existed before.
                let setupUrl = null;
                try {
                    const auto = await api(cfg, "POST", `/sessions/${encodeURIComponent(sessionId)}/autologin`, {});
                    if (auto.status === 200) {
                        const r = (await auto.json());
                        if (r.outcome === "already_authenticated" || r.outcome === "vault_login") {
                            return text({
                                mode: "auto",
                                signedIn: true,
                                via: r.outcome === "vault_login" ? "password manager" : "saved session",
                                next: "You are signed in — carry on. No human was needed.",
                            });
                        }
                        // Nothing is configured for this site. Remember the setup link so
                        // it can be offered alongside the handoff below — the user is
                        // already being interrupted, so this is the cheapest possible
                        // moment to tell them how to stop being interrupted next time.
                        if (r.setupRequired && r.setupUrl)
                            setupUrl = r.setupUrl;
                    }
                }
                catch {
                    /* fall through to the human handoff */
                }
                const res = await api(cfg, "POST", `/sessions/${encodeURIComponent(sessionId)}/handoff`, { reason: a.reason });
                if (res.status !== 200)
                    await apiError(res, "handoff request");
                const h = (await res.json());
                // The gateway is severing our socket right now. Drop the local handle
                // rather than leave a half-dead Browser object that throws confusing
                // Target-closed errors on every subsequent tool call.
                try {
                    await e.browser.close();
                }
                catch {
                    /* already gone — that is the point */
                }
                // Prefer the short link when the gateway offers one — it is far easier
                // to relay to someone on a phone. Fall back to the long URL for older
                // gateways that do not return shortUrl yet.
                const showUrl = h.shortUrl ?? h.url;
                return text({
                    mode: "hot",
                    handoffId: h.handoffId,
                    url: showUrl,
                    fullUrl: h.url,
                    expiresAt: h.expiresAt,
                    // Offered only when the account has NOTHING configured for this site.
                    // The user is already being interrupted, so this is the cheapest
                    // moment to show them how to stop being interrupted next time.
                    ...(setupUrl
                        ? {
                            setupUrl,
                            tip: "This account has no password manager connected for this site, so a human is " +
                                "needed every time. Connecting one at the setupUrl lets future logins happen " +
                                "automatically. MENTION THIS TO THE USER along with the sign-in link.",
                        }
                        : {}),
                    next: "Show the url to the user, then call solari_browser_await_login.",
                });
            },
        },
        solari_browser_save_profile: {
            description: "Save this session's signed-in state (cookies + localStorage) into an existing profile, " +
                "so future sessions start already logged in and no human is needed again. Pass the " +
                "profileId to overwrite.\n" +
                "ONLY do this when the user has asked you to remember the login. It is deliberately not " +
                "automatic: a saved profile holds live session cookies, which bypass 2FA — it is a " +
                "credential store, and it should exist because someone chose it. If they have not said " +
                "so, ask first.\n" +
                "Returns what was captured (cookie count and origins) so the user can see what they " +
                "just persisted.",
            inputSchema: {
                sessionId: z.string(),
                profileId: z.string(),
            },
            handler: async (a) => {
                need(a.sessionId);
                const res = await api(cfg, "POST", `/sessions/${encodeURIComponent(a.sessionId)}/save-profile`, { profileId: a.profileId });
                if (res.status !== 200)
                    await apiError(res, "save profile");
                const body = (await res.json());
                return text({
                    ...body,
                    note: "Future sessions can use this with solari_browser_create({profileId}).",
                });
            },
        },
        solari_browser_await_login: {
            description: "Wait for the human to finish the sign-in you requested with solari_browser_login. " +
                "Blocks until they are done, the link expires, or timeoutMs elapses. Returns only a " +
                "status — never anything the user typed. On 'completed' the session is yours again, " +
                "on the same page, still signed in, and you can carry on where you left off. On " +
                "'expired' or 'timeout' the user did not finish: ask if they still want to, and call " +
                "solari_browser_login again for a fresh link rather than retrying this.",
            inputSchema: {
                sessionId: z.string().optional(),
                profileId: z.string().optional(),
                sinceVersion: z.number().optional(),
                handoffId: z.string().optional(),
                timeoutMs: z.number().optional(),
            },
            handler: async (a) => {
                const sessionId = typeof a.sessionId === "string" ? a.sessionId : "";
                const profileId = typeof a.profileId === "string" ? a.profileId : "";
                if (Boolean(sessionId) === Boolean(profileId)) {
                    throw new Error("Pass exactly one of sessionId (hot handoff) or profileId (cold handoff) — the " +
                        "same one solari_browser_login returned.");
                }
                // Clamp: never spin forever, never poll so briefly the human has no
                // chance. Defaults to the handoff's own 5-minute life.
                const requested = typeof a.timeoutMs === "number" ? a.timeoutMs : 300_000;
                const deadline = Date.now() + Math.min(Math.max(requested, 5_000), 600_000);
                let status = "pending";
                // ── COLD: watch the profile's version, which the editor's save bumps.
                // Deliberately NOT "did a storageState appear": re-signing into a
                // profile that already had one must also count as completed.
                if (profileId) {
                    const since = typeof a.sinceVersion === "number" ? a.sinceVersion : 0;
                    let version = since;
                    while (Date.now() < deadline) {
                        const res = await api(cfg, "GET", "/profiles");
                        if (res.status !== 200)
                            await apiError(res, "profile status");
                        const rows = (await res.json());
                        const row = rows.find((p) => p.id === profileId);
                        if (!row)
                            throw new Error(`profile ${profileId} no longer exists`);
                        version = typeof row.version === "number" ? row.version : since;
                        if (version > since) {
                            status = "completed";
                            break;
                        }
                        await new Promise((r) => setTimeout(r, HANDOFF_POLL_MS));
                    }
                    if (status !== "completed")
                        status = "timeout";
                    return text({
                        mode: "cold",
                        status,
                        profileId,
                        version,
                        next: status === "completed"
                            ? `Signed in and saved. Use solari_browser_create({ profileId: "${profileId}" }) ` +
                                "and you will start already authenticated."
                            : "The user did not finish. Ask if they still want to, then call " +
                                "solari_browser_login again for a fresh link.",
                    });
                }
                const e = need(sessionId);
                while (Date.now() < deadline) {
                    const q = typeof a.handoffId === "string" && a.handoffId
                        ? `?handoffId=${encodeURIComponent(a.handoffId)}`
                        : "";
                    const res = await api(cfg, "GET", `/sessions/${encodeURIComponent(sessionId)}/handoff${q}`);
                    if (res.status !== 200)
                        await apiError(res, "handoff status");
                    const body = (await res.json());
                    status = body.status ?? "none";
                    // "none" means no open handoff and no id to look up — treat as done
                    // rather than spinning; the caller can re-mint if that was wrong.
                    if (status !== "pending")
                        break;
                    await new Promise((r) => setTimeout(r, HANDOFF_POLL_MS));
                }
                if (status === "pending")
                    status = "timeout";
                // Reconnect: the handoff severed our old socket on purpose, so the
                // stored handle is dead even on success. Re-dial and re-adopt the page
                // the human left us on, which is the whole point of a HOT handoff —
                // the agent resumes mid-flow instead of starting over.
                let resumed = false;
                if (status === "completed" || status === "none") {
                    try {
                        const browser = await deps.connect(e.cdpEndpoint);
                        const pages = await browser.pages();
                        const page = pages.find((p) => !p.isClosed()) ?? (await browser.newPage());
                        e.browser = browser;
                        e.page = page;
                        resumed = true;
                    }
                    catch (err) {
                        return text({
                            status,
                            resumed: false,
                            note: "the sign-in finished but the session could not be re-attached: " +
                                redact(err instanceof Error ? err.message : String(err)),
                        });
                    }
                }
                return text({
                    status,
                    resumed,
                    ...(resumed ? { url: e.page.url() } : {}),
                });
            },
        },
        solari_browser_navigate: {
            description: "Navigate the browser session to a URL. Returns final url, title and HTTP status.",
            inputSchema: { sessionId: z.string(), url: z.string() },
            handler: async (a) => {
                const page = await activePage(need(a.sessionId));
                let url = a.url.trim();
                if (!/^[a-z][a-z0-9+.-]*:/i.test(url))
                    url = `https://${url}`;
                const scheme = url.slice(0, url.indexOf(":")).toLowerCase();
                if (scheme !== "http" && scheme !== "https") {
                    throw new Error(`refusing to navigate to a non-http(s) URL (${scheme}:)`);
                }
                // Block link-local / cloud metadata so page content can't steer the
                // agent into reading the browser pool's instance credentials.
                const host = new URL(url).hostname;
                if (/^(169\.254\.|127\.|\[?::1\]?$|localhost$|metadata\.google)/i.test(host)) {
                    throw new Error(`refusing to navigate to internal host ${host}`);
                }
                const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
                return text({ url: page.url(), title: await page.title(), status: resp?.status() ?? null });
            },
        },
        solari_browser_observe: {
            description: "Read the page as numbered controls (e.g. `e7 button \"Search\"`) plus its visible text. " +
                "Cheaper and more precise than a screenshot or HTML. Act on a control with solari_browser_act.",
            inputSchema: { sessionId: z.string() },
            handler: async (a) => {
                const e = need(a.sessionId);
                const page = await activePage(e);
                e.observation = await browserObserve(page);
                return text(formatObservation(e.observation));
            },
        },
        solari_browser_act: {
            description: "Act on a control from the last solari_browser_observe by its id, then return the fresh " +
                "observation (no separate observe needed). action: click | type (text, submit?) | select (value) | " +
                "press (key) | scroll (direction). Refuses, without acting, if the control changed since it was observed.",
            inputSchema: {
                sessionId: z.string(),
                action: z.enum(["click", "type", "select", "press", "scroll"]),
                ref: z.string().optional(),
                text: z.string().optional(),
                submit: z.boolean().optional(),
                value: z.string().optional(),
                key: z.string().optional(),
                direction: z.enum(["up", "down"]).optional(),
            },
            handler: async (a) => {
                const e = need(a.sessionId);
                const page = await activePage(e);
                e.observation = await browserAct(page, e.observation, a);
                return text(formatObservation(e.observation));
            },
        },
        solari_browser_read_page: {
            description: "Read the current page. format 'text' (default) returns visible text; 'links' returns " +
                "clickable links {text, href}; 'html' returns HTML with scripts/styles stripped. " +
                "Large output is truncated with an explicit marker.",
            inputSchema: {
                sessionId: z.string(),
                format: z.enum(["text", "links", "html"]).optional(),
            },
            handler: async (a) => {
                const page = await activePage(need(a.sessionId));
                const fmt = a.format ?? "text";
                if (fmt === "links") {
                    const all = await page.$$eval("a[href]", (as) => as
                        .map((el) => ({
                        text: (el.textContent ?? "").trim().slice(0, 120),
                        href: el.href,
                    }))
                        .filter((l) => l.text));
                    // Truncate whole elements — slicing the serialized JSON would hand
                    // the model unparseable output.
                    const shown = all.slice(0, MAX_LINKS);
                    return text({ url: page.url(), shown: shown.length, total: all.length, links: shown });
                }
                let out;
                if (fmt === "html") {
                    out = await page.evaluate(() => {
                        const d = document.cloneNode(true);
                        d.querySelectorAll("script,style,noscript,svg").forEach((n) => n.remove());
                        return d.documentElement?.outerHTML ?? "";
                    });
                }
                else {
                    out = await page.evaluate(() => document.body?.innerText ?? "");
                }
                return text(`${page.url()}\n\n${capText(out, "chars")}`);
            },
        },
        solari_browser_screenshot: {
            description: "Screenshot the browser session's current page (JPEG). fullPage captures the whole " +
                "scrollable page (may be downscaled by the client if very tall).",
            inputSchema: {
                sessionId: z.string(),
                fullPage: z.boolean().optional(),
                quality: z.number().min(1).max(100).optional(),
            },
            handler: async (a) => {
                const page = await activePage(need(a.sessionId));
                const buf = await page.screenshot({
                    type: "jpeg",
                    quality: a.quality ?? 75,
                    fullPage: Boolean(a.fullPage),
                });
                return {
                    content: [
                        { type: "image", data: Buffer.from(buf).toString("base64"), mimeType: "image/jpeg" },
                    ],
                };
            },
        },
        solari_browser_click: {
            description: "Click on the page: give a CSS selector, or x/y viewport coordinates (e.g. from a screenshot).",
            inputSchema: {
                sessionId: z.string(),
                selector: z.string().optional(),
                x: z.number().optional(),
                y: z.number().optional(),
            },
            handler: async (a) => {
                const page = await activePage(need(a.sessionId));
                if (a.selector) {
                    await page.click(a.selector);
                }
                else if (typeof a.x === "number" && typeof a.y === "number") {
                    await page.mouse.click(a.x, a.y);
                }
                else {
                    throw new Error("provide selector or x+y");
                }
                return text({ ok: true, url: page.url() });
            },
        },
        solari_browser_type: {
            description: "Type text into the page. Optionally focus a CSS selector first. clear:true replaces the " +
                "field's existing value (otherwise text is appended at the caret). pressEnter submits.",
            inputSchema: {
                sessionId: z.string(),
                text: z.string(),
                selector: z.string().optional(),
                clear: z.boolean().optional(),
                pressEnter: z.boolean().optional(),
            },
            handler: async (a) => {
                const page = await activePage(need(a.sessionId));
                if (a.selector) {
                    const sel = a.selector;
                    await page.focus(sel);
                    if (a.clear) {
                        await page.$eval(sel, (el) => {
                            const f = el;
                            f.value = "";
                            f.dispatchEvent(new Event("input", { bubbles: true }));
                        });
                    }
                }
                // No per-key delay: 20 ms a character made a 200-character field take 4 s.
                await page.keyboard.type(a.text);
                if (a.pressEnter)
                    await page.keyboard.press("Enter");
                return text({ ok: true });
            },
        },
        solari_browser_key: {
            description: "Press a key in the browser session (e.g. 'Enter', 'Escape', 'ArrowDown', 'PageDown'). " +
                "Chords use '+' (e.g. 'Control+a').",
            inputSchema: { sessionId: z.string(), key: z.string() },
            handler: async (a) => {
                const page = await activePage(need(a.sessionId));
                const parts = a.key.split("+").filter(Boolean);
                const key = parts.pop();
                for (const m of parts)
                    await page.keyboard.down(m);
                try {
                    await page.keyboard.press(key);
                }
                finally {
                    for (const m of parts.reverse())
                        await page.keyboard.up(m);
                }
                return text({ ok: true });
            },
        },
        solari_browser_evaluate: {
            description: "Evaluate a JavaScript expression on the page and return its JSON-serialized result.",
            inputSchema: { sessionId: z.string(), expression: z.string() },
            handler: async (a) => {
                const page = await activePage(need(a.sessionId));
                // Pass the expression as a string: puppeteer sends it as a
                // debugger-originated Runtime.evaluate, which is exempt from the
                // page's CSP. Wrapping it in eval() inside page context is not.
                const result = await page.evaluate(a.expression);
                return text(result === undefined ? "undefined" : result);
            },
        },
        solari_browser_replay_url: {
            description: "Get the session-replay URL for a browser session created with recording: true. " +
                "May 404 for a few seconds right after close — retry.",
            inputSchema: { sessionId: z.string() },
            handler: async (a) => {
                const id = a.sessionId;
                const known = reg.sessions.get(id);
                if (known && !known.recording) {
                    throw new Error(`session ${id} was not created with recording: true, so it has no replay`);
                }
                const res = await api(cfg, "GET", `/sessions/${encodeURIComponent(id)}/replay-url`);
                if (!res.ok)
                    await apiError(res, "replay-url");
                return text(await res.json());
            },
        },
        solari_browser_close: {
            description: "Close a browser session and release it.",
            inputSchema: { sessionId: z.string() },
            handler: async (a) => {
                const id = a.sessionId;
                // Release FIRST: if it fails, keep the registry entry so the model can
                // retry rather than losing the handle to a still-billing session.
                await releaseBrowserSession(cfg, id, api);
                const e = reg.sessions.get(id);
                if (e) {
                    try {
                        await e.browser.disconnect();
                    }
                    catch {
                        /* already gone */
                    }
                    reg.sessions.delete(id);
                }
                return text({ ok: true });
            },
        },
    };
}
/** Release every browser session in a registry (used on eviction/shutdown). */
export async function releaseAllBrowserSessions(cfg, reg, fetchApi = api) {
    const ids = [...reg.sessions.keys()];
    await Promise.all(ids.map(async (id) => {
        const e = reg.sessions.get(id);
        reg.sessions.delete(id);
        try {
            await releaseBrowserSession(cfg, id, fetchApi);
        }
        catch (err) {
            console.error(`solari-mcp: failed to release browser session ${id}:`, err);
        }
        try {
            await e?.browser.disconnect();
        }
        catch {
            /* already gone */
        }
    }));
}
