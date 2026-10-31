/**
 * Local stdio MCP servers — secret resolution.
 * Pure validation lives in `shared/mcp/stdio-validation.ts` (no Node deps,
 * importable from the engine and the renderer); this module adds the
 * main-process pieces: OS-keychain `secret://` resolution.
 */

import { resolveSecrets } from "./secure-store";
import { stdioPath } from "./stdio-path";
import {
  validateStdioServer,
  parseClaudeStdioEntry,
} from "../../shared/mcp/stdio-validation";

export { validateStdioServer, parseClaudeStdioEntry };
export { ABS_PATH_RE, ENV_NAME_RE, COMMAND_TOKEN_RE } from "../../shared/mcp/stdio-validation";

/**
 * Resolve `secret://` refs in a stdio server's env map via the OS keychain.
 * Pure literal values pass through untouched. Never called in the renderer.
 */
export function resolveStdioEnv(env: Record<string, string> | undefined): Record<string, string> {
  const resolved = env ? resolveSecrets(env) : {};
  // A user-supplied PATH wins; otherwise extend the (often minimal) GUI-launch
  // PATH so `node`/`npx` shims from version managers resolve in packaged builds.
  // On Windows the key is canonicalized to PATH so the child never sees two
  // PATH-ish entries (`Path` + `PATH`) that would resolve unpredictably.
  const pathKey = Object.keys(resolved).find((k) => k.toLowerCase() === "path");
  if (process.platform === "win32" && pathKey && pathKey !== "PATH") {
    resolved.PATH = resolved[pathKey];
    delete resolved[pathKey];
  } else if (!pathKey) {
    resolved.PATH = stdioPath();
  }
  return resolved;
}

