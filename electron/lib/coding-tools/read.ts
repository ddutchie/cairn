/**
 * read tool — read file contents with optional line range.
 *
 * Ported from pi packages/coding-agent/src/core/tools/read.ts
 * TUI rendering, TypeBox schemas, and pluggable Operations removed.
 */

import fs from "fs";
import path from "path";

const MAX_LINES = 2000;
const MAX_BYTES = 200_000;

export interface ReadArgs {
  path: string;
  offset?: number; // 1-indexed line to start from
  limit?: number;  // max lines to return
}

export async function readTool(args: ReadArgs, cwd: string): Promise<string> {
  const filePath = path.isAbsolute(args.path) ? args.path : path.join(cwd, args.path);

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") throw new Error(`File not found: ${args.path}`);
    if (err.code === "EISDIR") throw new Error(`Path is a directory: ${args.path}`);
    throw new Error(`Cannot read ${args.path}: ${err.message}`);
  }

  const lines = content.split("\n");
  const total = lines.length;

  const offset = Math.max(1, args.offset ?? 1);
  const limit  = Math.min(args.limit ?? MAX_LINES, MAX_LINES);

  const start = offset - 1; // convert to 0-indexed
  const end   = Math.min(start + limit, total);
  const slice = lines.slice(start, end);

  let result = slice.map((line, i) => `${start + i + 1}: ${line}`).join("\n");

  // Byte cap
  if (Buffer.byteLength(result, "utf8") > MAX_BYTES) {
    const truncated: string[] = [];
    let bytes = 0;
    for (const line of slice) {
      const lineBytes = Buffer.byteLength(line + "\n", "utf8");
      if (bytes + lineBytes > MAX_BYTES) break;
      truncated.push(line);
      bytes += lineBytes;
    }
    result = truncated.map((line, i) => `${start + i + 1}: ${line}`).join("\n");
    result += `\n\n[Output truncated. Use offset=${start + truncated.length + 1} to continue.]`;
  }

  if (end < total) {
    result += `\n\n[Showing lines ${offset}–${end} of ${total}. Use offset=${end + 1} to continue.]`;
  }

  return result;
}

export const readToolDefinition = {
  type: "function" as const,
  function: {
    name: "read",
    description: "Read file contents. Supports line ranges via offset/limit. Returns line-numbered output.",
    parameters: {
      type: "object",
      properties: {
        path:   { type: "string", description: "File path relative to the project root" },
        offset: { type: "number", description: "1-indexed line to start from (default: 1)" },
        limit:  { type: "number", description: `Max lines to return (default: ${MAX_LINES})` },
      },
      required: ["path"],
    },
  },
};
