/**
 * write tool — write/overwrite a file entirely.
 *
 * Ported from pi packages/coding-agent/src/core/tools/write.ts
 */

import fs from "fs";
import path from "path";
import { withFileMutex } from "./file-mutex";
import { assertNotSecretFile } from "./secrets";
import { resolveContainedPath } from "./workspace-path";

export interface WriteArgs {
  path: string;
  content: string;
}

export async function writeTool(args: WriteArgs, cwd: string): Promise<string> {
  // Same containment contract as read/grep/find/ls: resolve against cwd and
  // reject absolute paths / `..` traversal / symlinks that escape the working
  // directory (e.g. the automation folder for a Develop session).
  const filePath = resolveContainedPath(cwd, args.path);
  if (!filePath) {
    throw new Error(`Path "${args.path}" escapes the working directory — files can only be written inside it.`);
  }
  assertNotSecretFile(filePath);

  return withFileMutex(filePath, async () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, args.content, "utf8");
    const bytes = Buffer.byteLength(args.content, "utf8");
    return `Successfully wrote ${bytes} bytes to ${args.path}`;
  });
}

export const writeToolDefinition = {
  type: "function" as const,
  function: {
    name: "write",
    description: "Write or overwrite a file with the given content. Creates parent directories as needed.",
    parameters: {
      type: "object",
      properties: {
        path:    { type: "string", description: "File path relative to the project root" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
    },
  },
};
