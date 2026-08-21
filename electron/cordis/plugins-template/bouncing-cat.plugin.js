/**
 * Example Cairn UI plugin: a cat emoji bouncing around the screen.
 *
 * Drop this into <userData>/plugins/ and add to plugins.yml (with
 * CAIRN_PLUGINS_DEV=1):
 *
 *   - id: bouncing-cat
 *     ui: ./bouncing-cat.plugin.js
 *
 * A UI plugin exports `activate(ui)`. `ui.React` is Cairn's React instance (use
 * it — never bundle your own). `ui.registerOverlay(id, Component)` mounts a
 * component into the frame-wide, click-through `app.overlay` layer. Edit this
 * file while Cairn runs and it hot-reloads.
 */
function activate(ui) {
  const { React } = ui;
  const { useState, useEffect, useRef } = React;

  function BouncingCat() {
    const [pos, setPos] = useState({ x: 40, y: 40 });
    const vel = useRef({ dx: 2.4, dy: 2.0 });

    useEffect(() => {
      let raf;
      const size = 44;
      const step = () => {
        setPos((p) => {
          const v = vel.current;
          let x = p.x + v.dx;
          let y = p.y + v.dy;
          const maxX = window.innerWidth - size;
          const maxY = window.innerHeight - size;
          if (x <= 0 || x >= maxX) { v.dx = -v.dx; x = Math.max(0, Math.min(maxX, x)); }
          if (y <= 0 || y >= maxY) { v.dy = -v.dy; y = Math.max(0, Math.min(maxY, y)); }
          return { x, y };
        });
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    }, []);

    return React.createElement(
      "div",
      {
        style: {
          position: "absolute",
          left: pos.x,
          top: pos.y,
          fontSize: 36,
          userSelect: "none",
          // The overlay layer is click-through; opt back in so the cat is clickable.
          pointerEvents: "auto",
          cursor: "grab",
          transition: "transform 80ms",
        },
        title: "Meow! (a live-loaded Cairn UI plugin)",
        onClick: () => { vel.current.dx *= 1.3; vel.current.dy *= 1.3; },
      },
      "\uD83D\uDC08", // 🐈
    );
  }

  ui.registerOverlay("bouncing-cat", BouncingCat);
}

// CommonJS-style export (the renderer loader evaluates with module/exports).
module.exports = { activate };
