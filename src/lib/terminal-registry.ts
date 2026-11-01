/**
 * Maps a terminal's `.xterm` element to its xterm instance so the app-wide
 * context menu can offer Copy / Paste / Clear. xterm paints to canvas, so the
 * DOM selection the generic menu reads is always empty — the terminal itself
 * owns the selection. Keyed by `terminal.element` (not the host container)
 * because that element is what moves when a terminal is re-attached to a new
 * container.
 */

import type { ITheme, Terminal } from "@xterm/xterm";
import { withAlpha } from "@/lib/viz/color";

const registry = new WeakMap<HTMLElement, Terminal>();

/**
 * xterm colours from the current theme tokens. Resolved to plain colours:
 * xterm can't parse `color-mix()` (which `--accent-dim` is), so the selection
 * tint is derived from `--accent` instead.
 */
export function terminalTheme(): ITheme {
  if (typeof document === "undefined") return {};
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const accent = read("--accent", "#8faf6f");
  return {
    background: read("--background", "#0d0d0d"),
    foreground: read("--text-primary", "#e8e4dc"),
    cursor: accent,
    cursorAccent: read("--background", "#0d0d0d"),
    selectionBackground: withAlpha(accent, 0.3),
  };
}

// Live terminals, re-themed when the app theme or accent changes (both land
// on <html>: data-theme, and the inline --accent* style set by applyAccent).
const live = new Set<WeakRef<Terminal>>();
let themeObserver: MutationObserver | null = null;

function retheme(): void {
  const theme = terminalTheme();
  for (const ref of live) {
    const terminal = ref.deref();
    if (!terminal) { live.delete(ref); continue; }
    // Detached terminals stay registered: TerminalManager keeps them across
    // navigation and SessionMount reattaches them, so they must pick up a
    // theme change made while they were off screen. Only a terminal that has
    // been garbage-collected or disposed drops out.
    try {
      terminal.options.theme = theme;
    } catch {
      live.delete(ref);
    }
  }
}

/** Call after `terminal.open()` so `terminal.element` exists. */
export function registerTerminal(terminal: Terminal): void {
  if (terminal.element) registry.set(terminal.element, terminal);
  live.add(new WeakRef(terminal));
  if (!themeObserver && typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    themeObserver = new MutationObserver(retheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
  }
}

/** Terminal whose `.xterm` element contains `target`, if any. */
export function findTerminalFor(target: Element): Terminal | null {
  const el = target.closest<HTMLElement>(".xterm");
  return (el && registry.get(el)) || null;
}
