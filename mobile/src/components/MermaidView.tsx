import { useMemo, useState } from "react";
import { useTheme, useIsDark } from "@/theme";
import { WebViewRenderer, buildAutoHeightScript, buildHtmlHead } from "@/components/WebViewRenderer";
import { CodeBlock } from "@/components/CodeBlock";
import { MERMAID_JS } from "@/webview-assets/mermaid-assets";

/**
 * Renders a Mermaid diagram in an auto-height WebView, offline (mermaid JS is
 * bundled). Theme follows the app colour scheme. If mermaid fails to parse the
 * diagram, we fall back to showing the raw source as a code block — matching
 * the desktop MermaidDiagram's graceful degradation.
 */
export function MermaidView({ code }: { code: string }) {
  const t = useTheme();
  const isDark = useIsDark();
  const [failed, setFailed] = useState(false);

  const html = useMemo(() => {
    // Escape `</` so a literal </script> inside the diagram source can't break
    // out of the inline <script> (JSON.stringify alone doesn't escape it).
    const safe = JSON.stringify(code).replace(/<\//g, "<\\/");
    return `<!doctype html><html><head>${buildHtmlHead(
      t,
      `#d { display: flex; justify-content: center; }
       #d svg { max-width: 100%; height: auto; }`,
    )}</head><body>
      <div id="d"></div>
      <script>${MERMAID_JS}</script>
      <!-- Defines window.__postError; must run BEFORE the render script below. -->
      <script>${buildAutoHeightScript()}</script>
      <script>
        (function () {
          try {
            mermaid.initialize({
              startOnLoad: false,
              theme: ${isDark ? "'dark'" : "'default'"},
              securityLevel: 'strict',
              fontFamily: '-apple-system, system-ui, sans-serif',
            });
            mermaid.render('cairn_g', ${safe}).then(function (res) {
              document.getElementById('d').innerHTML = res.svg;
              setTimeout(function () {
                var h = document.body.scrollHeight;
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'height', height: h }));
              }, 0);
            }).catch(function (e) {
              window.__postError && window.__postError(e && e.message ? e.message : e);
            });
          } catch (e) {
            window.__postError && window.__postError(e && e.message ? e.message : e);
          }
        })();
      </script>
    </body></html>`;
  }, [code, t, isDark]);

  if (failed) return <CodeBlock code={code} language="mermaid" />;

  return <WebViewRenderer html={html} minHeight={60} onError={() => setFailed(true)} />;
}
