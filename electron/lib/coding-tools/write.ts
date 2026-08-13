/**
 * write tool — write/overwrite a file entirely.
 *
 * Ported from pi packages/coding-agent/src/core/tools/write.ts
 */

import fs from "fs";
import path from "path";
import { withFileMutex } from "./file-mutex";
import { assertNotSecretFile } from "./secrets";

export interface WriteArgs {
  path: string;
  content: string;
}

export async function writeTool(args: WriteArgs, cwd: string): Promise<string> {
  const filePath = path.isAbsolute(args.path) ? args.path : path.join(cwd, args.path);
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
