/**
 * Shared test helper: parse the mobile chat tool definitions (name + description)
 * out of mobile/src/chat/tools.ts WITHOUT importing the module (it pulls in
 * React-Native-only deps that can't load under Node/vitest). Used by the AI
 * experiment tests so they exercise the real mobile tool set and stay in sync
 * with the source without a divergent copy in each test file.
 *
 * The emitted parameter schema is a generic object with `additionalProperties:
 * false`, matching mobile's hand-written `obj()` helper (mobile/src/chat/tools.ts).
 * Only names + descriptions matter for tool-selection tests; exact per-field
 * param shapes are not needed.
 */

import fs from "fs";
import path from "path";

export interface OpenAiToolDef {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

// Matches a ToolDef entry: `name: "..."` followed by `description:` whose string
// value may be a single- or multi-line (leading-newline) double-quoted literal
// with escaped quotes. Tolerant of formatting changes (optional whitespace /
// newline before the description string).
const TOOL_RE = /name:\s*"([a-z_]+)"\s*,\s*description:\s*"((?:[^"\\]|\\.)*)"/gs;

/** Parse mobile tools from source. Throws if none are found (guards against a
 *  formatting change silently emptying the set). */
export function parseMobileTools(
  toolsPath = path.resolve(__dirname, "../../mobile/src/chat/tools.ts"),
): OpenAiToolDef[] {
  const src = fs.readFileSync(toolsPath, "utf8");
  const out: OpenAiToolDef[] = [];
  let m: RegExpExecArray | null;
  while ((m = TOOL_RE.exec(src)) !== null) {
    out.push({
      type: "function",
      function: {
        name: m[1],
        description: m[2].replace(/\\"/g, '"'),
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    });
  }
  if (out.length === 0) {
    throw new Error(`parseMobileTools: no tools parsed from ${toolsPath} — the source format may have changed`);
  }
  return out;
}
