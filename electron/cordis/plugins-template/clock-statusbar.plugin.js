/**
 * Example Cairn UI plugin: a live clock in the status bar.
 *
 *   # plugins.yml
 *   - id: clock
 *     ui: ./clock-statusbar.plugin.js
 *
 * `ui.registerStatusBarItem(id, Component)` mounts into the persistent bottom
 * status bar (`app.statusbar`). The bar only appears once something is in it.
 */
function activate(ui) {
  const { React } = ui;
  const { useState, useEffect } = React;

  function Clock() {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
      const t = setInterval(() => setNow(new Date()), 1000);
      return () => clearInterval(t);
    }, []);
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return React.createElement(
      "span",
      { style: { fontVariantNumeric: "tabular-nums", opacity: 0.9 } },
      `\uD83D\uDD52 ${hh}:${mm}:${ss}`, // 🕒
    );
  }

  ui.registerStatusBarItem("clock", Clock, 100);
}

module.exports = { activate };
