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

const missing = [{ messageId: "missing" }];

tester.run("cairn/icon-button-label", cairn.rules["icon-button-label"] as unknown as Rule.RuleModule, {
  valid: [
    `<button aria-label="Close"><X /></button>`,
    `<button title="Close"><X /></button>`,
    `<button><X /> Close</button>`,
    `<button {...props}><X /></button>`,
    `<button aria-label={open ? "Hide" : "Show"}>{open ? <EyeOff /> : <Eye />}</button>`,
    `<IconButton label="Close"><X /></IconButton>`,
  ],
  invalid: [
    { code: `<button onClick={close}><X size={12} /></button>`, errors: missing },
    { code: `<button>{open ? <EyeOff /> : <Eye />}</button>`, errors: missing },
    { code: `<button>{busy && <Spinner />}</button>`, errors: missing },
  ],
});
