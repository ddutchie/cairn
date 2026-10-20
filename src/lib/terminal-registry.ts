/**
 * Maps a terminal's `.xterm` element to its xterm instance so the app-wide
 * context menu can offer Copy / Paste / Clear. xterm paints to canvas, so the
 * DOM selection the generic menu reads is always empty — the terminal itself
 * owns the selection. Keyed by `terminal.element` (not the host container)
 * because that element is what moves when a terminal is re-attached to a new
 * container.
 */

import type { Terminal } from "@xterm/xterm";

const registry = new WeakMap<HTMLElement, Terminal>();

/** Call after `terminal.open()` so `terminal.element` exists. */
export function registerTerminal(terminal: Terminal): void {
  if (terminal.element) registry.set(terminal.element, terminal);
}

/** Terminal whose `.xterm` element contains `target`, if any. */
export function findTerminalFor(target: Element): Terminal | null {
  const el = target.closest<HTMLElement>(".xterm");
  return (el && registry.get(el)) || null;
}
