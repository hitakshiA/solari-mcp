#!/usr/bin/env node
// CLI + bundle entry point: unconditionally start the stdio server. The
// import.meta.url main-gate in server.ts fails under npm bin symlinks (argv[1]
// is the symlink, import.meta.url the real file) and inside the esbuild cjs
// bundle — so both routes come through here instead.
import { main } from "./server.js";
main().catch((err) => {
    console.error("solari-mcp fatal:", err);
    process.exit(1);
});
