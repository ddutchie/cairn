import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, ActivityIndicator, StyleSheet, AppState } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useTheme, type Theme } from "@/theme";

/**
 * Auto-height WebView host for offline HTML rendering (KaTeX math, Mermaid
 * diagrams). The document must postMessage its rendered height (and optionally
 * an error) — see buildAutoHeightScript. The container background matches the
 * app theme so the WebView blends into the note/card surface.
 *
 * Everything is self-contained (library sources inlined as strings) so it works
 * fully offline; the WebView never issues a network or file:// request.
 */
export function WebViewRenderer({
  html,
  minHeight = 24,
  onError,
}: {
  html: string;
  minHeight?: number;
  onError?: (message: string) => void;
}) {
  const t = useTheme();
  const [height, setHeight] = useState(minHeight);
  const [loading, setLoading] = useState(true);
  const styles = useMemo(() => makeStyles(t), [t]);
  const ref = useRef<WebView>(null);

  // iOS reclaims a backgrounded WKWebView's content process under memory
  // pressure, leaving math/diagram blocks blank. reload() on a dead process is
  // unreliable, so we REMOUNT (bump a key → fresh native view from the in-memory
  // html) instead — immediately if foregrounded, else on the next foreground
  // (the terminate callback can arrive while JS is suspended). Android uses
  // onRenderProcessGone.
  const [webKey, setWebKey] = useState(0);
  const terminatedRef = useRef(false);
  const remount = useCallback(() => { setLoading(true); setWebKey((k) => k + 1); }, []);
  const handleTerminate = useCallback(() => {
    if (AppState.currentState === "active") remount();
    else terminatedRef.current = true;
  }, [remount]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && terminatedRef.current) {
        terminatedRef.current = false;
        remount();
      }
    });
    return () => sub.remove();
  }, [remount]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as { type: string; height?: number; error?: string };
      if (msg.type === "height" && typeof msg.height === "number") {
        setHeight(Math.max(minHeight, Math.ceil(msg.height)));
        setLoading(false);
      } else if (msg.type === "error" && msg.error) {
        setLoading(false);
        onError?.(msg.error);
      }
    } catch {
      // ignore malformed messages
    }
  };

  return (
    <View style={[styles.wrap, { height: height + 2 }]}>
      {loading ? <ActivityIndicator style={StyleSheet.absoluteFill} color={t.textTertiary} size="small" /> : null}
      <WebView
        ref={ref}
        key={webKey}
        originWhitelist={["*"]}
        source={{ html }}
        style={[styles.web, { opacity: loading ? 0 : 1 }]}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        onMessage={onMessage}
        // Static, bundled content only: allow the initial inline document to
        // load, and block ALL subsequent navigations (link taps, redirects) so
        // rendered note/diagram content can't navigate the WebView anywhere.
        onShouldStartLoadWithRequest={(req) =>
          req.url === "about:blank" || req.url.startsWith("data:") || req.navigationType === "other"
        }
        // iOS terminates the WKWebView content process when the app is
        // backgrounded under memory pressure, leaving math/diagram blocks blank.
        // reload() is unreliable on a dead process, so remount to re-render
        // (Android: onRenderProcessGone).
        onContentProcessDidTerminate={handleTerminate}
        onRenderProcessGone={handleTerminate}
        javaScriptEnabled
        setSupportMultipleWindows={false}
      />
    </View>
  );
}

/**
 * The tail script every WebView document runs: measure the body and post the
 * height back to RN (with a ResizeObserver so late layout — e.g. web fonts —
 * updates the container).
 */
export function buildAutoHeightScript(): string {
  return `
    (function () {
      function post(type, extra) {
        window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: type }, extra || {})));
      }
      function report() {
        var h = document.body ? document.body.scrollHeight : 0;
        post('height', { height: h });
      }
      window.__postError = function (msg) { post('error', { error: String(msg) }); };
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(report, 0);
      } else {
        document.addEventListener('DOMContentLoaded', report);
      }
      window.addEventListener('load', report);
      if (window.ResizeObserver) {
        new ResizeObserver(report).observe(document.documentElement);
      } else {
        setTimeout(report, 300);
      }
    })();
  `;
}

/** Shared <head> boilerplate: viewport + reset so content hugs the top-left. */
export function buildHtmlHead(t: Theme, extraCss = ""): string {
  return `
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <style>
      html, body { margin: 0; padding: 0; background: transparent; }
      body {
        color: ${t.textPrimary};
        font-family: -apple-system, system-ui, sans-serif;
        overflow: hidden;
        -webkit-text-size-adjust: 100%;
      }
      ${extraCss}
    </style>
  `;
}

function makeStyles(_t: Theme) {
  return StyleSheet.create({
    wrap: { width: "100%", backgroundColor: "transparent", marginVertical: 6 },
    web: { flex: 1, backgroundColor: "transparent" },
  });
}
