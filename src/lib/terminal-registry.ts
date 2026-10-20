/**
 * Maps a terminal's host element to its xterm instance so the app-wide context
 * menu can offer Copy / Paste / Clear. xterm paints to canvas, so the DOM
 * selection the generic menu reads is always empty — the terminal itself owns
 * the selection.
 */

import type { Terminal } from "@xterm/xterm";

const registry = new WeakMap<HTMLElement, Terminal>();

export function registerTerminalElement(host: HTMLElement, terminal: Terminal): void {
  registry.set(host, terminal);
}

/** Terminal whose host element contains `target`, if any. */
export function findTerminalFor(target: Element): Terminal | null {
  const host = target.closest(".xterm")?.parentElement;
  return (host && registry.get(host)) || null;
}
