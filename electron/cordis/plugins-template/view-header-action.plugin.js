/**
 * Example Cairn UI plugin: an action button in the view header (Topbar).
 *
 *   # plugins.yml
 *   - id: header-action
 *     ui: ./view-header-action.plugin.js
 *
 * `ui.register("view.header.actions", { id }, Component)` mounts a button on the
 * right side of the top bar. The component receives `{ view }` (the active
 * view), so it can adapt per view. (dsh alias: "conversation.session.header.actions".)
 */
function activate(ui) {
  const { React } = ui;

  function HeaderAction(props) {
    const { view } = props;
    return React.createElement(
      "button",
      {
        title: `Plugin action (current view: ${view})`,
        onClick: () => alert(`Hello from a plugin! You're on the "${view}" view.`),
        style: {
          display: "inline-flex", alignItems: "center", gap: 6,
          height: 28, padding: "0 10px", borderRadius: 8, fontSize: 12,
          color: "var(--text-secondary)", background: "var(--surface-2)",
          border: "1px solid var(--border)", cursor: "pointer",
        },
      },
      React.createElement("span", null, "\u2728"), // ✨
      React.createElement("span", null, "Action"),
    );
  }

  ui.register("view.header.actions", { id: "demo-action" }, HeaderAction);
}

module.exports = { activate };
