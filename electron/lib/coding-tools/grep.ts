/**
 * grep tool — search file contents with regex.
 *
 * Ported from pi packages/coding-agent/src/core/tools/grep.ts
 */

import fs from "fs";
import path from "path";

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

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "out", "build", ".turbo"]);

function matchesInclude(filePath: string, include?: string): boolean {
  if (!include) return true;
  // Simple glob: support *.ext and **/*.ext
  const pattern = include.replace(/\*\*/g, "__GLOB__").replace(/\*/g, "[^/]*").replace(/__GLOB__/g, ".*");
  return new RegExp(pattern + "$").test(filePath);
}

function searchDir(
  dirPath: string,
  regex: RegExp,
  include: string | undefined,
  results: GrepMatch[]
): void {
  if (results.length >= MAX_RESULTS) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      searchDir(path.join(dirPath, entry.name), regex, include, results);
    } else if (entry.isFile()) {
      const filePath = path.join(dirPath, entry.name);
      if (!matchesInclude(filePath, include)) continue;
      try {
        const content = fs.readFileSync(filePath, "utf8");
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
    stat = fs.statSync(searchPath);
  } catch {
    throw new Error(`Path not found: ${args.path ?? "."}`);
  }

  if (stat.isFile()) {
    const content = fs.readFileSync(searchPath, "utf8");
    content.split("\n").forEach((line, i) => {
      if (regex.test(line)) results.push({ file: searchPath, line: i + 1, content: line.trim() });
    });
  } else {
    searchDir(searchPath, regex, args.include, results);
  }

  if (results.length === 0) return "No matches found.";

  const lines = results.map((r) => {
    const rel = path.relative(cwd, r.file);
    return `${rel}:${r.line}: ${r.content}`;
  });

  const output = lines.join("\n");
  const suffix = results.length >= MAX_RESULTS ? `\n\n[Showing first ${MAX_RESULTS} matches]` : "";
  return output + suffix;
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
