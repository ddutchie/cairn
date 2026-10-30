/**
 * Pure stdio validation for local MCP servers — no Node/Electron imports so
 * it can run in the main process, the engine runtime, and the renderer.
 *
 * Security model (mirrored everywhere this is used):
 *  - No shell: the command + args spawn directly (no interpolation).
 *  - `command` is a bare executable name (PATH lookup) or an absolute path.
 *    Shell metacharacters, whitespace, and `..` are rejected.
 *  - `cwd`, when set, must be absolute (POSIX `/…` or Windows `X:\…`/`X:/…`).
 *  - `env` names follow the conservative POSIX subset; values are strings.
 */

/** Absolute path on POSIX (`/…`) or Windows (`X:\…`, `X:/…`). */
export const ABS_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/;

/** Bare executable token (PATH lookup): no separators, no shell syntax. */
export const COMMAND_TOKEN_RE = /^[A-Za-z0-9_@.+-]+$/;

/** Env var name grammar (conservative POSIX subset). */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Max lengths — a typo'd 1MB env value should fail fast, not spawn. */
export const MAX_ARG_BYTES = 4096;
export const MAX_ENV_VALUE_BYTES = 16384;

export interface StdioValidation {
  ok: boolean;
  errors: string[];
}

export function isAbsolutePath(p: string): boolean {
  return ABS_PATH_RE.test(p);
}

function isBareCommandToken(command: string): boolean {
  return COMMAND_TOKEN_RE.test(command);
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
  if (/\s/.test(command) || /[;&|<>$`'"!]/.test(command)) {
    errors.push("command must be a bare executable or absolute path (no shell, no arguments inline — use args)");
  } else if (isAbsolutePath(command)) {
    if (command.includes("..")) errors.push("command path must not contain ..");
    // Drive-letter colon + backslash separators are part of the absolute path.
  } else {
    if (command.includes("/") || command.includes("\\") || command.includes("..")) {
      errors.push("command must be a bare executable name or absolute path");
    } else if (!isBareCommandToken(command)) {
      errors.push("command must be a bare executable name or absolute path");
    }
  }
  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || !input.args.every((a) => typeof a === "string")) {
      errors.push("args must be an array of strings");
    } else if ((input.args as string[]).some((a) => a.length > MAX_ARG_BYTES)) {
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
        if ((v as string).length > MAX_ENV_VALUE_BYTES) {
          errors.push(`env var ${k} is too long`);
          break;
        }
      }
    }
  }
  const cwd = (input.cwd ?? "").trim();
  if (cwd) {
    if (!isAbsolutePath(cwd)) errors.push("cwd must be an absolute path");
    else if (cwd.includes("..")) errors.push("cwd must not contain ..");
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * Parse a pasted Claude Desktop `mcpServers` entry (`{command, args, env}`)
 * into a Cairn stdio draft. Throws on invalid shape.
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
