/**
 * ls tool — list directory contents.
 *
 * Ported from pi packages/coding-agent/src/core/tools/ls.ts
 */

import fs from "fs";
import path from "path";

export interface LsArgs {
  path?: string; // directory to list (default: cwd)
}

export async function lsTool(args: LsArgs, cwd: string): Promise<string> {
  const dirPath = args.path
    ? (path.isAbsolute(args.path) ? args.path : path.join(cwd, args.path))
    : cwd;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") throw new Error(`Directory not found: ${args.path ?? "."}`);
    if (err.code === "ENOTDIR") throw new Error(`Not a directory: ${args.path}`);
    throw new Error(`Cannot list ${args.path ?? "."}: ${err.message}`);
  }

  if (entries.length === 0) return "(empty directory)";

  const lines = entries
    .sort((a, b) => {
      // Directories first, then files, alphabetical within each group
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

  return lines.join("\n");
}

export const lsToolDefinition = {
  type: "function" as const,
  function: {
    name: "ls",
    description: "List the contents of a directory. Directories are shown with a trailing slash.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list (default: project root)" },
      },
      required: [],
    },
  },
};
