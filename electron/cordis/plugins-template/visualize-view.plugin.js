/**
 * Spike (UI half): a Cairn port of the `visualize` toolview from
 * github:Nagi-ovo/dsh-visualize.
 *
 *   # plugins.yml
 *   - id: visualize
 *     name: ./visualize-tool.mjs
 *     ui: ./visualize-view.plugin.js   # this file
 *
 * Registers a `tool.call.toolview` keyed to `visualize`: it reads the tool's
 * durable HTML result and renders it inside a sandboxed <iframe sandbox="allow-scripts">
 * — the same technique as dsh-visualize (replay-stable from the logged slice,
 * frame unreachable from the host, height auto-sized via postMessage).
 *
 * This proves a dsh community-plugin UI SHAPE runs in Cairn's transcript with no
 * dsh shell — just our tool.call.toolview slot + a Cairn-built ToolCallViewProps.
 */
const HEIGHT_MSG = "cairn-visualize-height";

function activate(ui) {
  const { React } = ui;
  const { useEffect, useState } = React;

  const readHtml = (block) => {
    if (block && "kind" in block && Array.isArray(block.content)) {
      for (const b of block.content) if (b.type === "text" && b.text) return b.text;
    }
    return null;
  };
  const cssVar = (n, fb) => {
    try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb; }
    catch { return fb; }
  };

  function VisualizeCard(props) {
    const { block, callId } = props;
    const running = !block || !("kind" in block);
    const html = readHtml(block);
    const [height, setHeight] = useState(60);

    useEffect(() => {
      const onMsg = (e) => {
        const d = e.data;
        if (!d || d.type !== HEIGHT_MSG || d.token !== callId) return;
        if (typeof d.height === "number") setHeight(Math.max(48, Math.min(Math.ceil(d.height), 800)));
      };
      addEventListener("message", onMsg);
      return () => removeEventListener("message", onMsg);
    }, [callId]);

    if (running) return React.createElement("div", { style: { fontSize: 12, opacity: 0.6, padding: "4px 0" } }, "\u2728 rendering visualization…");
    if (!html) return React.createElement("div", { style: { fontSize: 12, color: "var(--danger)" } }, "visualization failed");

    const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
      :root{color-scheme:light dark}
      body{margin:0;font-family:system-ui,sans-serif;color:${cssVar("--text-primary", "#e5e5e5")};background:transparent}
      a{color:${cssVar("--accent", "#3b82f6")}}
    </style></head><body>${html}
    <script>
      function report(){parent.postMessage({type:${JSON.stringify(HEIGHT_MSG)},token:${JSON.stringify(callId)},height:document.documentElement.scrollHeight},"*")}
      new ResizeObserver(report).observe(document.documentElement);report();
    <\/script></body></html>`;

    return React.createElement(
      "div",
      { style: { margin: "4px 0" } },
      React.createElement("div", { style: { fontSize: 12, opacity: 0.6, marginBottom: 4 } }, "\u2728 Visualization"),
      React.createElement("iframe", {
        sandbox: "allow-scripts",
        srcDoc: doc,
        style: { display: "block", width: "100%", border: 0, background: "transparent", height },
      }),
    );
  }

  ui.registerToolView("visualize", VisualizeCard);
  // dsh parity: the real plugin registers key:'visualize' on tool.call.toolview
  // via ctx.slots.register — ui.registerToolView is Cairn's equivalent.
}

module.exports = { activate };
