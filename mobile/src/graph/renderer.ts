export type GraphRenderer = "skia" | "webview";

/**
 * Which implementation draws the Graph tab. Skia is the default; set
 * EXPO_PUBLIC_GRAPH_RENDERER=webview in the build environment to fall back to
 * the D3 WebView for a release while the Skia renderer bakes. The WebView path
 * is deleted once the Skia one has shipped cleanly.
 */
export const GRAPH_RENDERER: GraphRenderer =
  process.env.EXPO_PUBLIC_GRAPH_RENDERER === "webview" ? "webview" : "skia";
