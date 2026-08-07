/**
 * find tool — find files by name pattern.
 *
 * Ported from pi packages/coding-agent/src/core/tools/find.ts
 */

import fs from "fs";
import path from "path";
import { truncateOutput } from "../truncation";
import { resolveContainedPath } from "./workspace-path";

const MAX_RESULTS = 50;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "out", "build", ".turbo"]);

export interface FindArgs {
  pattern: string; // substring or glob-style pattern to match against filenames
  path?: string;   // directory to search (default: cwd)
}

function matchesPattern(name: string, pattern: string): boolean {
  // Support simple glob: * matches anything except /
  if (pattern.includes("*")) {
    const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$", "i");
    return re.test(name);
  }
  return name.toLowerCase().includes(pattern.toLowerCase());
}

async function findFiles(
  dirPath: string,
  pattern: string,
  results: string[],
  cwd: string
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
      await findFiles(path.join(dirPath, entry.name), pattern, results, cwd);
    } else if (entry.isFile()) {
      if (matchesPattern(entry.name, pattern)) {
        results.push(path.relative(cwd, path.join(dirPath, entry.name)));
      }
    }
  }
}

export async function findTool(args: FindArgs, cwd: string): Promise<string> {
  const searchPath = resolveContainedPath(cwd, args.path);
  if (!searchPath) throw new Error(`Path is outside the workspace: ${args.path ?? "."}`);

  try {
    await fs.promises.stat(searchPath);
  } catch {
    throw new Error(`Directory not found: ${args.path ?? "."}`);
  }

  const results: string[] = [];
  await findFiles(searchPath, args.pattern, results, cwd);

  if (results.length === 0) return `No files matching "${args.pattern}" found.`;

  const raw = results.join("\n");
  const { text } = truncateOutput(raw, {
    hint: results.length >= MAX_RESULTS
      ? `[Showing first ${MAX_RESULTS} results — narrow the search path or pattern to see more.]`
      : undefined,
  });
  return text;
}

export const findToolDefinition = {
  type: "function" as const,
  function: {
    name: "find",
    description: "Find files by name pattern. Searches recursively, skipping node_modules, .git, dist etc.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Filename pattern to match (substring or glob with *)" },
        path:    { type: "string", description: "Directory to search (default: project root)" },
      },
      required: ["pattern"],
    },
  },
};
