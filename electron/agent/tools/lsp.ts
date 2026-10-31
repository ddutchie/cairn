/** lsp: read-only code navigation through a language server. */
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import type { LspManager } from "../lsp";
import { fail, ok } from "./schema";

export interface LspDeps { manager: LspManager; cwd: string }

export function lspTool({ manager, cwd }: LspDeps): AgentTool | undefined {
  if (!manager.available) return undefined;
  return defineTool({
    name: "lsp",
    description: "Code navigation through the language server (TypeScript/JavaScript): find a symbol's definition, its references or implementations, or read its hover info. Lines and columns are 1-based.",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("definition"), Type.Literal("references"), Type.Literal("implementation"), Type.Literal("hover")]),
      path: Type.String({ description: "File path, relative to the working directory." }),
      line: Type.Number(),
      character: Type.Number(),
    }),
    risk: (a) => ({ class: "READ", paths: [path.resolve(cwd, a.path)] }),
    async execute(a) {
      try { return ok(await manager.client(cwd).query(a.operation, path.resolve(cwd, a.path), a.line, a.character)); }
      catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
    },
  });
}
