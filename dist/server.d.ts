#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ZodTypeAny } from "zod";
import { SolariClient } from "@solarisdk/sdk";
import { type BrowserConfig, type BrowserRegistry } from "./browser.js";
type Kind = "sandbox" | "desktop";
interface Entry {
    kind: Kind;
    handle: any;
    commands: any[];
}
export interface Registry {
    sessions: Map<string, Entry>;
}
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
export declare function makeToolset(client: SolariClient, reg: Registry): Record<string, Tool>;
export declare function registerToolset(server: McpServer, toolset: Record<string, Tool>): void;
export interface ServerParts {
    server: McpServer;
    browserReg: BrowserRegistry;
    /** Sandbox/desktop registry — the caller must close these on teardown. */
    vmReg: Registry;
    browserCfg: BrowserConfig;
}
/**
 * Drop our control-channel sockets for every sandbox/desktop in a registry.
 *
 * This is required, not cosmetic: the gateway treats a session with any open
 * control/stream connection as active and never expires it, so leaving the
 * channel open defeats idle-pause and the VM bills indefinitely. We close
 * (not kill) so the customer keeps their VM and its own idle policy applies.
 */
export declare function closeAllVmSessions(reg: Registry): Promise<void>;
export declare function buildServerParts(client?: SolariClient, browserCfg?: BrowserConfig): ServerParts;
export declare function buildServer(client?: SolariClient, browserCfg?: BrowserConfig): McpServer;
export declare function main(): Promise<void>;
export {};
