/**
 * Local stdio MCP servers — validation, secret resolution, and dsh config
 * mapping. Single home for everything stdio-specific so the hand bridge
 * (`mcp-client.ts`, remote-only) never grows process-spawning code.
 *
 * Security model:
 *  - No shell: dsh spawns `command` + `args` directly (no interpolation).
 *  - `command` must be a bare executable name (PATH lookup) or an absolute
 *    path. Shell metacharacters, whitespace, and `..` are rejected here;
 *    dsh re-validates at load.
 *  - `cwd`, when set, must be absolute. Unset defaults to the workspace dir
 *    at mount time (resolved by the caller, never stored).
 *  - `env` values may be `secret://` refs; they resolve via the OS keychain
 *    in the main process only (see `resolveStdioEnv`).
 */

import { resolveSecrets } from "./secure-store";

/** Env var name grammar for stdio servers (conservative POSIX subset). */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Reject shell metacharacters / whitespace in the executable token. */
const COMMAND_TOKEN_RE = /^[A-Za-z0-9_@.+-]+$/;

export interface StdioValidation {
  ok: boolean;
  errors: string[];
}

export function validateStdioServer(input: {
  command?: string;
  args?: unknown;
  env?: unknown;
  cwd?: string | null;
}): StdioValidation {
  const errors: string[] = [];
  const command = (input.command ?? "").trim();
  if (!command) {
    errors.push("command is required for stdio servers");
    return { ok: false, errors };
  }
  if (command.includes(" ") || /[;&|<>$`'"\\]/.test(command)) {
    errors.push("command must be a bare executable or absolute path (no shell, no arguments inline — use args)");
  } else if (command.startsWith("/")) {
    if (command.includes("..")) errors.push("command path must not contain ..");
  } else if (!COMMAND_TOKEN_RE.test(command)) {
    errors.push("command must be a bare executable name or absolute path");
  }
  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || !input.args.every((a) => typeof a === "string")) {
      errors.push("args must be an array of strings");
    } else if ((input.args as string[]).some((a) => a.length > 4096)) {
      errors.push("args entries must be under 4096 characters");
    }
  }
  if (input.env !== undefined) {
    if (typeof input.env !== "object" || input.env === null || Array.isArray(input.env)) {
      errors.push("env must be an object of NAME to value");
    } else {
      for (const [k, v] of Object.entries(input.env as Record<string, unknown>)) {
        if (!ENV_NAME_RE.test(k)) {
          errors.push(`env var name ${JSON.stringify(k)} is invalid`);
          break;
        }
        if (typeof v !== "string") {
          errors.push(`env var ${k} must be a string`);
          break;
        }
        if ((v as string).length > 16384) {
          errors.push(`env var ${k} is too long`);
          break;
        }
      }
    }
  }
  const cwd = (input.cwd ?? "").trim();
  if (cwd) {
    if (!cwd.startsWith("/")) errors.push("cwd must be an absolute path");
    else if (cwd.includes("..")) errors.push("cwd must not contain ..");
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * Resolve `secret://` refs in a stdio server's env map via the OS keychain.
 * Pure literal values pass through untouched. Never called in the renderer.
 */
export function resolveStdioEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  return resolveSecrets(env);
}

/** dsh serverName grammar — renaming to fit it would break tool-name parity. */
export const DSH_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

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

/**
 * Parse a pasted Claude Desktop `mcpServers` entry (`{command, args, env}`)
 * into a Cairn stdio draft. Throws on invalid shape — callers surface the
 * message in the form.
 */
export function parseClaudeStdioEntry(
  name: string,
  entry: unknown,
): { command: string; args: string[]; env: Record<string, string> } {
  const e = entry as { command?: unknown; args?: unknown; env?: unknown } | null;
  if (!e || typeof e !== "object") throw new Error(`"${name}" must be an object with a command`);
  if (typeof e.command !== "string" || !e.command.trim()) throw new Error(`"${name}" needs a command string`);
  const args = e.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    throw new Error(`"${name}".args must be an array of strings`);
  }
  const env: Record<string, string> = {};
  if (e.env !== undefined) {
    if (typeof e.env !== "object" || e.env === null || Array.isArray(e.env)) {
      throw new Error(`"${name}".env must be an object`);
    }
    for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
      if (typeof v !== "string") throw new Error(`"${name}".env.${k} must be a string`);
      env[k] = v;
    }
  }
  const v = validateStdioServer({ command: e.command, args, env });
  if (!v.ok) throw new Error(`"${name}": ${v.errors.join("; ")}`);
  return { command: e.command.trim(), args: [...args], env };
}
