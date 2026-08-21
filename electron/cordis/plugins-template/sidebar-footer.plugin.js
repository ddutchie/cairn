/**
 * Example Cairn UI plugin: a link/button pinned to the sidebar bottom.
 *
 *   # plugins.yml
 *   - id: sidebar-link
 *     ui: ./sidebar-footer.plugin.js
 *
 * `ui.register("sidebar.footer", { id }, Component)` mounts a row under the
 * Settings button in the left sidebar. (Also reachable via the dsh alias
 * "sidebar.footer.action" through ui.registerBySlot.)
 */
function activate(ui) {
  const { React } = ui;

  function DocsLink() {
    return React.createElement(
      "button",
      {
        onClick: () => window.open("https://opencode.ai/docs", "_blank"),
        style: {
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          borderRadius: 6, padding: "6px 8px", fontSize: 12, textAlign: "left",
          color: "var(--text-tertiary)", background: "transparent",
          border: "none", cursor: "pointer",
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = "var(--surface-2)"; e.currentTarget.style.color = "var(--text-primary)"; },
        onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-tertiary)"; },
      },
      React.createElement("span", null, "\uD83D\uDCD6"), // 📖
      React.createElement("span", null, "Plugin Docs"),
    );
  }

  ui.register("sidebar.footer", { id: "docs-link" }, DocsLink);
}

module.exports = { activate };
