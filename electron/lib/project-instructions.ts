/**
 * Project instruction files for coding sessions: AGENTS.md (preferred) or CLAUDE.md in the working
 * directory and each parent up to the repo root. `@path` lines import another file, so a CLAUDE.md that
 * only says `@AGENTS.md` doesn't duplicate it. Read per prompt, so edits apply to the next message.
 */
import fs from "node:fs";
import path from "node:path";

const NAMES = ["AGENTS.md", "CLAUDE.md"];
const MAX_TOTAL = 24_000;
const MAX_IMPORT_DEPTH = 3;

function expand(file: string, seen: Set<string>, depth: number): string {
  const real = (() => { try { return fs.realpathSync(file); } catch { return file; } })();
  if (seen.has(real)) return "";
  seen.add(real);
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return ""; }
  if (depth >= MAX_IMPORT_DEPTH) return text;
  return text.split("\n").map((line) => {
    const m = /^@(\S+)\s*$/.exec(line.trim());
    return m && !m[1].startsWith("/") && !m[1].startsWith("~") ? expand(path.resolve(path.dirname(file), m[1]), seen, depth + 1) : line;
  }).join("\n");
}

/** Instruction files from the repo root down to `cwd` (most general first), or "" when there are none. */
export function loadProjectInstructions(cwd: string): string {
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir || dirs.length >= 6) break;
  }
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const dir of dirs) {
    const found = NAMES.map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
    if (!found) continue;
    const body = expand(found, seen, 0).trim();
    if (body) parts.push(dir === dirs[dirs.length - 1] ? body : `(${path.relative(cwd, found) || found})\n${body}`);
  }
  const all = parts.join("\n\n");
  return all.length > MAX_TOTAL ? `${all.slice(0, MAX_TOTAL)}\n…(truncated)` : all;
}
