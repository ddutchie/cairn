/**
 * @yao-pkg/pkg configuration for the cairn-mcp binary.
 *
 * The `assets` array tells pkg to embed better_sqlite3.node inside the binary.
 * At runtime the binary extracts it to a temp directory; mcp-server.ts resolves
 * it via process.execPath (see resolveMcpNativeBinding).
 */
module.exports = {
  assets: ["pkg-native/better_sqlite3.node"],
  outputPath: "dist-mcp",
};
