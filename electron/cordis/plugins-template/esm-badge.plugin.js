/**
 * Example Cairn UI plugin authored as ESM (import / export) instead of CJS.
 *
 *   # plugins.yml
 *   - id: esm-badge
 *     ui: ./esm-badge.plugin.js
 *
 * The loader detects ESM syntax and evaluates it via a Blob module URL, with
 * bare imports ("react") rewritten onto Cairn's platform module table (one
 * shared React). This is the format real dsh community plugins use.
 */
import { createElement, useEffect, useState } from "react";

export function activate(ui) {
  function Badge() {
    const [n, setN] = useState(0);
    useEffect(() => {
      const t = setInterval(() => setN((x) => x + 1), 1000);
      return () => clearInterval(t);
    }, []);
    return createElement(
      "div",
      {
        style: {
          position: "absolute", bottom: 16, left: 16,
          padding: "6px 10px", borderRadius: 8, fontSize: 12,
          background: "var(--accent)", color: "var(--accent-fg, #fff)",
          pointerEvents: "auto", boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
        },
        title: "An ESM plugin (import/export)",
      },
      `ESM badge · ${n}s`,
    );
  }
  ui.registerOverlay("esm-badge", Badge);
}
