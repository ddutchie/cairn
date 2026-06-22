/**
 * Dev-only tracing for the SSE → tool-arg → note-write pipeline.
 *
 * Active only when CAIRN_TOOL_TRACE=1 or NODE_ENV=development (the latter is
 * the default for Electron dev builds started via `electron-vite dev`). Logs
 * lengths + short SHA-256 hashes + head/tail snippets — never full payloads,
 * to avoid leaking note content into logs.
 */

import { createHash } from "node:crypto";

const TRACE =
  process.env.CAIRN_TOOL_TRACE === "1" ||
  process.env.NODE_ENV === "development";

export function traceTool(
  stage: "sse-args" | "parse" | "lookup" | "pre-write" | "persisted",
  fields: Record<string, string | number | undefined>,
): void {
  if (!TRACE) return;
  const bits: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (typeof v === "number") {
      bits.push(`${k}=${v}`);
    } else if (v === "") {
      bits.push(`${k}=len:0`);
    } else {
      const sha = createHash("sha256").update(v).digest("hex").slice(0, 12);
      const head = v.slice(0, 32).replace(/\n/g, "\\n");
      const tail = v.slice(-32).replace(/\n/g, "\\n");
      bits.push(`${k}=len:${v.length} sha:${sha} head:${head} tail:${tail}`);
    }
  }
  if (bits.length === 0) return;
  console.debug(`[tool-trace:${stage}]`, bits.join(" "));
}
