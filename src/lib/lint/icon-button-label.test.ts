import { describe, it } from "vitest";
import { RuleTester, type Rule } from "eslint";
import tsParser from "@typescript-eslint/parser";
// eslint-rules/ sits outside src; the rule ships with the ESLint config.
import cairn from "../../../eslint-rules/cairn.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

const useIconButton = [{ messageId: "useIconButton" }];

tester.run("cairn/icon-button-label", cairn.rules["icon-button-label"] as unknown as Rule.RuleModule, {
  valid: [
    `<button><X /> Close</button>`,
    `<button>{label}</button>`,
    `<IconButton label="Close"><X /></IconButton>`,
  ],
  invalid: [
    { code: `<button onClick={close}><X size={12} /></button>`, errors: useIconButton },
    // A label doesn't make a raw icon button acceptable any more.
    { code: `<button aria-label="Close"><X /></button>`, errors: useIconButton },
    { code: `<button {...props}><X /></button>`, errors: useIconButton },
    { code: `<button>{open ? <EyeOff /> : <Eye />}</button>`, errors: useIconButton },
    { code: `<button>{busy && <Spinner />}</button>`, errors: useIconButton },
  ],
});
