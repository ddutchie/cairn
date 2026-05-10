/**
 * edit tool — targeted string replacement in files.
 *
 * Ported from pi packages/coding-agent/src/core/tools/edit.ts
 * Keeps: diff-based edit, file mutex, BOM/line-ending normalisation.
 * Added: unified diff returned in tool output so the model can verify its edits.
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

// ── Minimal unified diff ──────────────────────────────────────────────────────

const DIFF_CONTEXT_LINES = 3;

/**
 * Generate a compact unified diff between two strings.
 * No external dependencies — uses a simple LCS-based line diff.
 */
function generateUnifiedDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Build LCS table (Myers-style, but simple DP for correctness)
  const m = oldLines.length;
  const n = newLines.length;

  // For large files use a heuristic: only diff changed regions to stay fast
  // dp[i][j] = length of LCS of oldLines[0..i-1] and newLines[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to get edit script
  type Op = { type: "eq" | "del" | "ins"; line: string };
  const ops: Op[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: "eq", line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "ins", line: newLines[j - 1] });
      j--;
    } else {
      ops.push({ type: "del", line: oldLines[i - 1] });
      i--;
    }
  }
  ops.reverse();

  // Group into hunks with context
  const hunks: string[] = [];
  let hunkLines: string[] = [];
  let oldLine = 1, newLine = 1;
  let hunkOldStart = 1, hunkNewStart = 1;
  let inHunk = false;

  const flushHunk = () => {
    if (hunkLines.length > 0) {
      const oldCount = hunkLines.filter(l => l.startsWith("-") || l.startsWith(" ")).length;
      const newCount = hunkLines.filter(l => l.startsWith("+") || l.startsWith(" ")).length;
      hunks.push(`@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@\n${hunkLines.join("\n")}`);
      hunkLines = [];
    }
    inHunk = false;
  };

  let pendingContext: string[] = [];

  for (const op of ops) {
    if (op.type === "eq") {
      if (inHunk) {
        hunkLines.push(` ${op.line}`);
        pendingContext.push(` ${op.line}`);
        if (pendingContext.length > DIFF_CONTEXT_LINES * 2) {
          // Too much context — flush hunk and start fresh
          flushHunk();
          pendingContext = pendingContext.slice(-DIFF_CONTEXT_LINES);
        }
      } else {
        pendingContext.push(` ${op.line}`);
        if (pendingContext.length > DIFF_CONTEXT_LINES) pendingContext.shift();
      }
      oldLine++;
      newLine++;
    } else {
      if (!inHunk) {
        // Start new hunk — include trailing context from before
        hunkOldStart = oldLine - pendingContext.length;
        hunkNewStart = newLine - pendingContext.length;
        hunkLines = [...pendingContext];
        pendingContext = [];
        inHunk = true;
      }
      if (op.type === "del") {
        hunkLines.push(`-${op.line}`);
        oldLine++;
      } else {
        hunkLines.push(`+${op.line}`);
        newLine++;
      }
    }
  }
  flushHunk();

  if (hunks.length === 0) return "";

  return `--- a/${filePath}\n+++ b/${filePath}\n${hunks.join("\n")}`;
}

// ── Tool ──────────────────────────────────────────────────────────────────────

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

    const diff = generateUnifiedDiff(normalised, updated, args.path);
    const editCount = args.edits.length;
    const summary = `Applied ${editCount} edit${editCount === 1 ? "" : "s"} to ${args.path}`;

    return diff ? `${summary}\n\n${diff}` : summary;
  });
}

export const editToolDefinition = {
  type: "function" as const,
  function: {
    name: "edit",
    description:
      "Make targeted string replacements in a file. Each edit replaces an exact oldText with newText. " +
      "oldText must match exactly — include enough surrounding lines to make it unique. " +
      "Always read the file first to get the exact content. " +
      "Returns a unified diff of all changes made.",
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
