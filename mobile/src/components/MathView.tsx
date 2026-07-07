import { useMemo } from "react";
import { useTheme } from "@/theme";
import { WebViewRenderer, buildAutoHeightScript, buildHtmlHead } from "@/components/WebViewRenderer";
import { KATEX_JS, KATEX_CSS } from "@/webview-assets/katex-assets";

/**
 * Renders a single KaTeX math expression in an auto-height WebView, offline
 * (katex JS + CSS with base64-inlined woff2 fonts are bundled). `display` picks
 * block ($$…$$) vs inline ($…$) mode, mirroring the desktop MathBlock / inline
 * math split.
 */
export function MathView({ latex, display }: { latex: string; display: boolean }) {
  const t = useTheme();
  const html = useMemo(() => {
    // Escape `</` so a literal </script> in the latex can't break out of the
    // inline <script> (JSON.stringify alone doesn't escape it).
    const safe = JSON.stringify(latex).replace(/<\//g, "<\\/");
    return `<!doctype html><html><head>${buildHtmlHead(
      t,
      `${KATEX_CSS}
       .cairn-math { padding: 2px 0; ${display ? "text-align:center;" : ""} color: ${t.textPrimary}; overflow-x: auto; }
       .katex { color: ${t.textPrimary}; font-size: ${display ? "1.15em" : "1em"}; }`,
    )}</head><body>
      <div class="cairn-math" id="m"></div>
      <script>${KATEX_JS}</script>
      <!-- Defines window.__postError; must run BEFORE the render script below. -->
      <script>${buildAutoHeightScript()}</script>
      <script>
        try {
          katex.render(${safe}, document.getElementById('m'), {
            displayMode: ${display ? "true" : "false"},
            throwOnError: false,
            output: 'html',
          });
        } catch (e) { window.__postError && window.__postError(e && e.message ? e.message : e); }
      </script>
    </body></html>`;
  }, [latex, display, t]);

  return <WebViewRenderer html={html} minHeight={display ? 40 : 22} />;
}
