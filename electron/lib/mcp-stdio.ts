/**
 * Local stdio MCP servers — secret resolution and dsh config mapping.
 * Pure validation lives in `shared/mcp/stdio-validation.ts` (no Node deps,
 * importable from the Cordis runtime and the renderer); this module adds the
 * main-process pieces: OS-keychain `secret://` resolution.
 */

import { resolveSecrets } from "./secure-store";
import {
  validateStdioServer,
  parseClaudeStdioEntry,
} from "../../shared/mcp/stdio-validation";

export { validateStdioServer, parseClaudeStdioEntry };
export { ABS_PATH_RE, ENV_NAME_RE, COMMAND_TOKEN_RE } from "../../shared/mcp/stdio-validation";

/** dsh's serverName grammar — renaming to fit it would break tool-name parity. */
export const DSH_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Resolve `secret://` refs in a stdio server's env map via the OS keychain.
 * Pure literal values pass through untouched. Never called in the renderer.
 */
export function resolveStdioEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  return resolveSecrets(env);
}

export function toDshStdioConfig(server: {
  id: string;
  command: string;
  args?: string[] | null;
  env?: Record<string, string> | null;
  cwd?: string | null;
  workspacePath?: string | null;
}): { eligible: true; config: Record<string, unknown> } | { eligible: false; reason: string } {
  const v = validateStdioServer({ command: server.command, args: server.args ?? [], env: server.env ?? {}, cwd: server.cwd ?? "" });
  if (!v.ok) return { eligible: false, reason: `invalid-stdio: ${v.errors.join("; ")}` };
  if (!DSH_SERVER_NAME_RE.test(server.id)) {
    return { eligible: false, reason: `server-name: id ${JSON.stringify(server.id)} is outside dsh's [A-Za-z0-9_-]{1,32} namespace` };
  }
  const env = resolveStdioEnv(server.env ?? {});
  return {
    eligible: true,
    config: {
      transport: "stdio",
      serverName: server.id,
      command: server.command.trim(),
      args: [...(server.args ?? [])],
      env,
      cwd: (server.cwd ?? "").trim() || server.workspacePath || process.cwd(),
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    },
  };
}
