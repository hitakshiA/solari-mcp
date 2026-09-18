import { type Browser, type Page } from "puppeteer-core";
import { type ZodTypeAny } from "zod";
export interface McpResult {
    content: Array<{
        type: "text";
        text: string;
    } | {
        type: "image";
        data: string;
        mimeType: string;
    }>;
    isError?: boolean;
}
export interface Tool {
    description: string;
    inputSchema: Record<string, ZodTypeAny>;
    handler: (args: Record<string, unknown>) => Promise<McpResult>;
}
export interface BrowserConfig {
    apiKey: string;
    baseUrl: string;
}
interface BrowserEntry {
    sessionId: string;
    browser: Browser;
    page: Page;
    expiresAt: string;
    recording: boolean;
    /**
     * The session's raw CDP endpoint, kept so the handoff flow can RECONNECT.
     *
     * A login handoff severs the agent's socket gateway-side — deliberately, so
     * the agent cannot watch the human type. That kills this entry's puppeteer
     * handle, so resuming afterwards needs a fresh connect rather than the dead
     * one. Without this the agent "resumes" into a Target-closed error.
     */
    cdpEndpoint: string;
}
export interface BrowserRegistry {
    sessions: Map<string, BrowserEntry>;
}
declare function api(cfg: BrowserConfig, method: string, path: string, body?: unknown): Promise<Response>;
/** Release a browser session gateway-side. Safe to call for unknown ids. */
export declare function releaseBrowserSession(cfg: BrowserConfig, id: string, fetchApi?: typeof api): Promise<void>;
export interface BrowserDeps {
    connect: (cdpEndpoint: string) => Promise<Browser>;
    fetchApi: typeof api;
}
export declare function makeBrowserToolset(cfg: BrowserConfig, reg: BrowserRegistry, deps?: BrowserDeps): Record<string, Tool>;
/** Release every browser session in a registry (used on eviction/shutdown). */
export declare function releaseAllBrowserSessions(cfg: BrowserConfig, reg: BrowserRegistry, fetchApi?: typeof api): Promise<void>;
export {};
