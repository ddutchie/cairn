/**
 * Example Cairn UI plugin: a cost / token widget under the chat composer.
 *
 *   # plugins.yml
 *   - id: cost-widget
 *     ui: ./cost-widget.plugin.js
 *
 * `ui.registerChatFooter(id, Component)` mounts into `chat.transcript.footer`,
 * the band under the chat input. The component receives Cairn's OWN live usage
 * as props: { threadId, usage: { promptTokens, completionTokens, costUsd? } }.
 * (This is the Cairn-native alternative to dsh's useProjection cost UI — the
 * data is pushed in as props, no session-projection pipeline required.)
 */
function activate(ui) {
  const { React } = ui;

  function fmt(n) {
    if (n == null) return "0";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  function CostWidget(props) {
    const u = props.usage;
    if (!u) {
      return React.createElement(
        "div",
        { style: { fontSize: 11, color: "var(--text-tertiary)", padding: "2px 0" } },
        "\uD83D\uDCB0 no usage yet", // 💰
      );
    }
    const total = (u.promptTokens || 0) + (u.completionTokens || 0);
    const cost = u.costUsd != null ? `$${u.costUsd.toFixed(4)}` : null;
    return React.createElement(
      "div",
      {
        style: {
          display: "flex", gap: 10, alignItems: "center",
          fontSize: 11, color: "var(--text-tertiary)",
          padding: "2px 0",
          fontVariantNumeric: "tabular-nums",
        },
      },
      React.createElement("span", null, `\uD83D\uDCCA ${fmt(total)} tokens`), // 📊
      React.createElement("span", { style: { opacity: 0.6 } },
        `(${fmt(u.promptTokens)} in / ${fmt(u.completionTokens)} out)`),
      cost ? React.createElement("span", { style: { color: "var(--accent)" } }, cost) : null,
    );
  }

  ui.registerChatFooter("cost-widget", CostWidget);
}

module.exports = { activate };
