/** Spellcheck actions invoked from the renderer's context menu. */

import { registerContractHandle } from "./registry";
import { handle } from "./result-helpers";

export function registerSpellcheckHandlers(): void {
  registerContractHandle("spellcheck:replace", (e, { word }) =>
    handle(async () => {
      e.sender.replaceMisspelling(word);
    }),
  );

  registerContractHandle("spellcheck:addWord", (e, { word }) =>
    handle(async () => {
      e.sender.session.addWordToSpellCheckerDictionary(word);
    }),
  );
}
