import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import type { WorkPhase } from "@cairn/shared/conversation/work-phase";
import { useTheme } from "@/theme";
import { LOADERSZ_JS } from "@/webview-assets/loadersz-assets";

/** One loadersz canvas animation per phase — the same mapping as the desktop `WorkLoader`. */
const STATE: Record<WorkPhase, string> = {
  sending: "rendering",
  thinking: "scanning",
  responding: "typing",
  tools: "prioritizing",
  working: "marqueeing",
  retrying: "retrying",
  compacting: "summarizing",
  waiting: "waiting",
};

function buildHtml(size: number, phase: WorkPhase, color: string): string {
  return `<!doctype html><html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}canvas{display:block}</style>
</head><body><canvas id="c"></canvas>
<script>${LOADERSZ_JS}</script>
<script>
  var loader = null;
  window.__setPhase = function (state, color) {
    if (loader) loader.destroy();
    loader = new window.__loaders[state](document.getElementById('c'), { size: ${size}, color: color, forceMotion: true });
  };
  window.__setPhase(${JSON.stringify(STATE[phase])}, ${JSON.stringify(color)});
</script></body></html>`;
}

/**
 * Animated activity indicator for a chat turn in flight. The canvas animations only run in a
 * browser engine, so each one lives in a tiny transparent WebView; phase and accent changes are
 * injected rather than reloaded so the view isn't rebuilt per phase.
 */
export function WorkLoader({ phase, size = 20 }: { phase: WorkPhase; size?: number }) {
  const t = useTheme();
  const ref = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  // The document is built once for the first phase; later phases are injected.
  const [html] = useState(() => buildHtml(size, phase, t.accent));

  useEffect(() => {
    if (!ready) return;
    ref.current?.injectJavaScript(`window.__setPhase(${JSON.stringify(STATE[phase])}, ${JSON.stringify(t.accent)}); true;`);
  }, [phase, t.accent, ready]);

  return (
    <View style={{ width: size, height: size }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {!ready ? <ActivityIndicator style={StyleSheet.absoluteFill} size="small" color={t.accent} /> : null}
      <WebView
        ref={ref}
        originWhitelist={["*"]}
        source={{ html }}
        style={[styles.web, { opacity: ready ? 1 : 0 }]}
        scrollEnabled={false}
        bounces={false}
        onLoadEnd={() => setReady(true)}
        onShouldStartLoadWithRequest={(req) => req.url === "about:blank" || req.url.startsWith("data:") || req.navigationType === "other"}
        javaScriptEnabled
        setSupportMultipleWindows={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: "transparent" },
});
