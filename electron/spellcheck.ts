/**
 * Spellcheck bridge. Chromium's spellchecker (OS-backed on macOS) is on by
 * default; we just forward the right-clicked misspelling to the renderer, whose
 * Radix context menu shows the suggestions (see AppContextMenu).
 */

import type { WebContents } from "electron";
import { sendIpcEvent } from "./ipc/registry";

export function attachSpellcheck(contents: WebContents): void {
  contents.on("context-menu", (_event, params) => {
    if (!params.misspelledWord) return;
    sendIpcEvent(contents, "spellcheck:context", {
      word: params.misspelledWord,
      suggestions: params.dictionarySuggestions.slice(0, 5),
      x: params.x,
      y: params.y,
    });
  });
}
