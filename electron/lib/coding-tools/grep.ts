/**
 * grep tool — search file contents with regex.
 *
 * Ported from pi packages/coding-agent/src/core/tools/grep.ts
 */

import fs from "fs";
import path from "path";
import { truncateOutput } from "../truncation";

const MAX_RESULTS = 100;

export interface GrepArgs {
  pattern: string;
  path?: string;   // directory or file to search (default: cwd)
  include?: string; // glob pattern to filter files e.g. "*.ts"
}

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "out", "build", ".turbo", ".venv", "venv", "env", ".env", "__pycache__"]);
const SKIP_EXTS = new Set([".pyc", ".pyo", ".pyd", ".class", ".o", ".obj", ".dll", ".dylib", ".so", ".bin"]);

function matchesInclude(filePath: string, include?: string): boolean {
  if (!include) return true;
  // Simple glob: support *.ext and **/*.ext
  const pattern = include.replace(/\*\*/g, "__GLOB__").replace(/\*/g, "[^/]*").replace(/__GLOB__/g, ".*");
  return new RegExp(pattern + "$").test(filePath);
}

async function searchDir(
  dirPath: string,
  regex: RegExp,
  include: string | undefined,
  results: GrepMatch[]
): Promise<void> {
  if (results.length >= MAX_RESULTS) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await searchDir(path.join(dirPath, entry.name), regex, include, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      const filePath = path.join(dirPath, entry.name);
      if (!matchesInclude(filePath, include)) continue;
      try {
        // Async read — the main process yields between files so IPC to the
        // renderer (chips, token stream) keeps flowing during large searches.
        const content = await fs.promises.readFile(filePath, "utf8");
        const lines = content.split("\n");
        lines.forEach((line, i) => {
          if (results.length >= MAX_RESULTS) return;
          if (regex.test(line)) {
            results.push({ file: filePath, line: i + 1, content: line.trim() });
          }
        });
      } catch { /* skip unreadable files */ }
    }
  }
}

export async function grepTool(args: GrepArgs, cwd: string): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern);
  } catch {
    throw new Error(`Invalid regex pattern: ${args.pattern}`);
  }

  const searchPath = args.path
    ? (path.isAbsolute(args.path) ? args.path : path.join(cwd, args.path))
    : cwd;

  const results: GrepMatch[] = [];

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(searchPath);
  } catch {
    throw new Error(`Path not found: ${args.path ?? "."}`);
  }

  if (stat.isFile()) {
    const ext = path.extname(searchPath).toLowerCase();
    if (SKIP_EXTS.has(ext)) return "Cannot search binary files.";
    const content = await fs.promises.readFile(searchPath, "utf8");
    content.split("\n").forEach((line, i) => {
      if (regex.test(line)) results.push({ file: searchPath, line: i + 1, content: line.trim() });
    });
  } else {
    await searchDir(searchPath, regex, args.include, results);
  }

  if (results.length === 0) return "No matches found.";

  const lines = results.map((r) => {
    const rel = path.relative(cwd, r.file);
    return `${rel}:${r.line}: ${r.content}`;
  });

  const raw = lines.join("\n");
  const { text } = truncateOutput(raw, {
    hint: results.length >= MAX_RESULTS
      ? `[Showing first ${MAX_RESULTS} matches — use a more specific pattern to narrow results.]`
      : undefined,
  });
  return text;
}

export const grepToolDefinition = {
  type: "function" as const,
  function: {
    name: "grep",
    description: "Search file contents using a regex pattern. Returns file paths, line numbers, and matching lines.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path:    { type: "string", description: "Directory or file to search (default: project root)" },
        include: { type: "string", description: "Glob pattern to filter files, e.g. \"*.ts\" or \"**/*.tsx\"" },
      },
      required: ["pattern"],
    },
  },
};
