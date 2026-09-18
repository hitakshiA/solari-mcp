// The single source of truth for the version this server reports to MCP
// clients (`initialize` → serverInfo.version).
//
// It CANNOT be imported straight from package.json: tsconfig pins
// `rootDir: "src"`, so `import "../package.json"` is outside the root and tsc
// refuses it; widening rootDir would emit `dist/src/*.js` and break the `bin`
// path + the esbuild bundles. So it is a literal here — and
// `test/version.test.mjs` FAILS the build if it ever drifts from package.json.
//
// KEEP IN SYNC WITH sdk/mcp/package.json "version".
export const VERSION = "0.5.0";
