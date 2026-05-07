/**
 * edit tool — targeted string replacement in files.
 *
 * Ported from pi packages/coding-agent/src/core/tools/edit.ts
 * Keeps: diff-based edit, file mutex, BOM/line-ending normalisation.
 * Removed: TUI rendering, TypeBox schemas, pluggable Operations.
 */

import fs from "fs";
import path from "path";
import { withFileMutex } from "./file-mutex";

export interface EditEntry {
  oldText: string;
  newText: string;
}

export interface EditArgs {
  path: string;
  edits: EditEntry[];
}

function stripBom(s: string): { content: string; hasBom: boolean } {
  if (s.charCodeAt(0) === 0xFEFF) return { content: s.slice(1), hasBom: true };
  return { content: s, hasBom: false };
}

type LineEnding = "\r\n" | "\n";

function detectLineEnding(s: string): LineEnding {
  return s.includes("\r\n") ? "\r\n" : "\n";
}

function normalise(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

function restore(s: string, le: LineEnding): string {
  if (le === "\r\n") return s.replace(/\n/g, "\r\n");
  return s;
}

function applyEdits(content: string, edits: EditEntry[]): string {
  let result = content;
  for (const { oldText, newText } of edits) {
    const normOld = normalise(oldText);
    const idx = result.indexOf(normOld);
    if (idx === -1) {
      throw new Error(
        `edit: oldText not found in file.\n` +
        `Looking for:\n${oldText.slice(0, 200)}${oldText.length > 200 ? "…" : ""}`
      );
    }
    const count = result.split(normOld).length - 1;
    if (count > 1) {
      throw new Error(
        `edit: oldText matches ${count} locations — provide more surrounding context to make it unique.`
      );
    }
    result = result.slice(0, idx) + normalise(newText) + result.slice(idx + normOld.length);
  }
  return result;
}

export async function editTool(args: EditArgs, cwd: string): Promise<string> {
  if (!args.edits || args.edits.length === 0) {
    throw new Error("edit: edits array must not be empty");
  }

  const filePath = path.isAbsolute(args.path) ? args.path : path.join(cwd, args.path);

  return withFileMutex(filePath, async () => {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") throw new Error(`File not found: ${args.path}`);
      throw new Error(`Cannot read ${args.path}: ${err.message}`);
    }

    const { content: noBom, hasBom } = stripBom(raw);
    const lineEnding = detectLineEnding(noBom);
    const normalised = normalise(noBom);

    const updated = applyEdits(normalised, args.edits);

    const final = (hasBom ? "\uFEFF" : "") + restore(updated, lineEnding);
    fs.writeFileSync(filePath, final, "utf8");

    const editCount = args.edits.length;
    return `Applied ${editCount} edit${editCount === 1 ? "" : "s"} to ${args.path}`;
  });
}

export const editToolDefinition = {
  type: "function" as const,
  function: {
    name: "edit",
    description:
      "Make targeted string replacements in a file. Each edit replaces an exact oldText with newText. " +
      "oldText must match exactly — include enough surrounding lines to make it unique. " +
      "Always read the file first to get the exact content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root" },
        edits: {
          type: "array",
          description: "List of replacements to apply in order",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Exact text to find (must be unique in the file)" },
              newText: { type: "string", description: "Text to replace it with" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
};
