/**
 * Spellcheck bridge. Chromium's spellchecker (OS-backed on macOS) is on by
 * default; we just forward the right-clicked misspelling to the renderer, whose
 * Radix context menu shows the suggestions (see AppContextMenu).
 */

import type { WebContents } from "electron";
import { sendIpcEvent } from "./ipc/registry";

/** Last misspelling forwarded per window: the only word the renderer may act on. */
const forwarded = new WeakMap<WebContents, { word: string; suggestions: string[] }>();

export function lastForwardedMisspelling(contents: WebContents) {
  return forwarded.get(contents);
}

export function attachSpellcheck(contents: WebContents): void {
  contents.on("context-menu", (_event, params) => {
    if (!params.misspelledWord) return;
    const suggestions = params.dictionarySuggestions.slice(0, 5);
    forwarded.set(contents, { word: params.misspelledWord, suggestions });
    sendIpcEvent(contents, "spellcheck:context", {
      word: params.misspelledWord,
      suggestions,
      x: params.x,
      y: params.y,
    });
  });
}
