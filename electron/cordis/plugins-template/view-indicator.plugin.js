/**
 * Example Cairn UI plugin: a status-bar item that shows the current view.
 *
 *   # plugins.yml
 *   - id: view-indicator
 *     ui: ./view-indicator.plugin.js
 *
 * Demonstrates SLOT PROPS: an `app.statusbar` component receives
 * `{ activeView, activeProjectId }`, so a plugin can react to app state — no
 * store access, no imports. Cairn passes the data in.
 */
function activate(ui) {
  const { React } = ui;

  function ViewIndicator(props) {
    const { activeView, activeProjectId } = props;
    return React.createElement(
      "span",
      { style: { display: "inline-flex", gap: 6, alignItems: "center", opacity: 0.85 } },
      React.createElement("span", {
        style: { width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", display: "inline-block" },
      }),
      React.createElement("span", null, `view: ${activeView}`),
      activeProjectId
        ? React.createElement("span", { style: { opacity: 0.6 } }, `· project ${String(activeProjectId).slice(0, 6)}`)
        : null,
    );
  }

  ui.registerStatusBarItem("view-indicator", ViewIndicator, 0);
}

module.exports = { activate };
