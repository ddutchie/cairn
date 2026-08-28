/**
 * Example Cairn UI plugin: the classic bouncing DVD logo.
 *
 * The screensaver everyone waited to hit the corner. Bounces off the edges and
 * changes colour on every wall hit; corner hits flash + count.
 *
 *   # plugins.yml
 *   - id: bouncing-dvd
 *     ui: ./bouncing-dvd.plugin.js
 *
 * A UI plugin exports `activate(ui)`. Use `ui.React` (Cairn's React — never
 * bundle your own). `ui.registerOverlay(id, Component)` mounts into the
 * frame-wide, click-through `app.overlay` layer. Edit this file while Cairn runs
 * and it hot-reloads.
 */
function activate(ui) {
  const { React } = ui;
  const { useState, useEffect, useRef } = React;

  const COLORS = ["#e50914", "#00b3ff", "#ffd200", "#00e08a", "#ff5cf4", "#ff8a00", "#8b5cf6"];
  const W = 90, H = 40;

  function BouncingDVD() {
    const [pos, setPos] = useState({ x: 60, y: 60 });
    const [colorIdx, setColorIdx] = useState(0);
    const [corners, setCorners] = useState(0);
    const [flash, setFlash] = useState(false);
    const vel = useRef({ dx: 2.2, dy: 1.9 });

    useEffect(() => {
      let raf;
      const bump = () => setColorIdx((i) => (i + 1) % COLORS.length);
      const step = () => {
        setPos((p) => {
          const v = vel.current;
          let x = p.x + v.dx;
          let y = p.y + v.dy;
          const maxX = window.innerWidth - W;
          const maxY = window.innerHeight - H;
          let hitX = false, hitY = false;
          if (x <= 0 || x >= maxX) { v.dx = -v.dx; x = Math.max(0, Math.min(maxX, x)); hitX = true; }
          if (y <= 0 || y >= maxY) { v.dy = -v.dy; y = Math.max(0, Math.min(maxY, y)); hitY = true; }
          if (hitX || hitY) bump();
          if (hitX && hitY) { // the legendary corner hit
            setCorners((c) => c + 1);
            setFlash(true);
            setTimeout(() => setFlash(false), 400);
          }
          return { x, y };
        });
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    }, []);

    const color = COLORS[colorIdx];
    return React.createElement(
      "div",
      {
        style: {
          position: "absolute",
          left: pos.x,
          top: pos.y,
          width: W,
          height: H,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 8,
          background: color,
          color: "#000",
          fontWeight: 800,
          fontStyle: "italic",
          fontSize: 20,
          letterSpacing: "-1px",
          fontFamily: "Arial, sans-serif",
          boxShadow: flash ? `0 0 30px 6px ${color}` : "0 2px 10px rgba(0,0,0,0.3)",
          userSelect: "none",
          pointerEvents: "auto", // opt back in (the overlay layer is click-through)
          cursor: "pointer",
          transition: "box-shadow 200ms",
        },
        title: corners > 0 ? `Corner hits: ${corners} 🎉` : "Waiting for a corner…",
        onClick: () => { vel.current.dx *= 1.25; vel.current.dy *= 1.25; },
      },
      "DVD",
    );
  }

  ui.registerOverlay("bouncing-dvd", BouncingDVD);
  // dsh-compatibility: ui.registerBySlot("shell.overlay", { id: "bouncing-dvd" }, BouncingDVD)
  // resolves via the dsh⇄Cairn alias to app.overlay. See dsh-slot-map.ts.
}

module.exports = { activate };
