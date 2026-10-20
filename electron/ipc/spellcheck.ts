/**
 * Spellcheck actions invoked from the renderer's context menu.
 *
 * The renderer is untrusted: both handlers only act on the misspelling that
 * `attachSpellcheck` last forwarded to that window (and, for replace, on one of
 * its suggestions), so a compromised renderer can't rewrite the user's
 * persistent dictionary or inject arbitrary text.
 */

import { registerContractHandle } from "./registry";
import { handle } from "./result-helpers";
import { lastForwardedMisspelling } from "../spellcheck";

const MAX_WORD_LENGTH = 100;

function assertWord(word: unknown): asserts word is string {
  if (typeof word !== "string" || word.length === 0 || word.length > MAX_WORD_LENGTH) {
    throw new Error("Invalid spellcheck word");
  }
}

export function registerSpellcheckHandlers(): void {
  registerContractHandle("spellcheck:replace", (e, { word }) =>
    handle(async () => {
      assertWord(word);
      const last = lastForwardedMisspelling(e.sender);
      if (!last?.suggestions.includes(word)) throw new Error("Not a suggestion for the current misspelling");
      e.sender.replaceMisspelling(word);
    }),
  );

  registerContractHandle("spellcheck:addWord", (e, { word }) =>
    handle(async () => {
      assertWord(word);
      if (lastForwardedMisspelling(e.sender)?.word !== word) throw new Error("Not the current misspelling");
      e.sender.session.addWordToSpellCheckerDictionary(word);
    }),
  );
}
