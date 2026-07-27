/**
 * @yao-pkg/pkg configuration for the cairn-mcp binary.
 *
 * We do NOT embed better_sqlite3.node as a pkg asset. pkg cannot load a native
 * .node addon from its virtual /snapshot filesystem, and embedding it made the
 * runtime resolver pick a /snapshot path that `fs.existsSync` reports as present
 * but `require()` then fails to load — crashing the binary at startup.
 *
 * Instead, build-mcp-binary.js stages the arch-matched binding as a real file
 * next to the executable (dist-mcp/better_sqlite3-<arch>.node) and
 * resolveMcpNativeBinding() loads THAT via process.execPath — a real, loadable
 * on-disk path. electron-builder ships those sidecars (see electron-builder.yml).
 */
module.exports = {
  outputPath: "dist-mcp",
};
