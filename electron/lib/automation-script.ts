/**
 * run_script — named, pre-registered script execution for automations.
 *
 * Executes a script from the automation's `scripts/` folder by name, with the
 * run's working folder as cwd and the automation's `out/` folder exposed via
 * env. Cross-platform interpreter resolution:
 *
 *   .js / .ts  → Node (the app's bundled runtime — guaranteed on every OS;
 *               system `node` is preferred in dev, else Electron-as-Node)
 *   .sh        → bash (Git Bash on Windows)
 *   .py        → python3 / python / py (best-effort — must be installed)
 *   .bat/.cmd  → cmd.exe (Windows only)
 *   .ps1       → PowerShell (Windows)
 *   (no ext)   → direct exec / shebang (POSIX; .exe on Windows)
 *
 * Only a script NAME is ever accepted — resolution stays strictly inside the
 * scripts dir, so a name can never escape the automation folder. Args are
 * passed as an array (no shell string → no injection surface).
 *
 * Execution reuses the bash tool's hardening: streaming output with throttled
 * updates, a hard byte cap, a timeout, abort + process-group kill, and tracked
 * PIDs cleaned up on app shutdown (killTrackedBashProcesses).
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { DEFAULT_MAX_BYTES } from "./truncation";
import { getBashExecutable, killProcessTree, trackPid, untrackPid } from "./coding-tools/bash";

export const RUN_SCRIPT_TOOL_NAME = "run_script";
export const WRITE_RUN_FILE_TOOL_NAME = "write_run_file";

export interface RunScriptArgs {
  /** Script name (resolved inside the automation's scripts/ folder). */
  name: string;
  /** Positional arguments passed to the script — never shell-parsed. */
  args?: string[];
  /** Timeout in seconds (default 120). */
  timeout?: number;
}

export type RunScriptHandler = (args: RunScriptArgs) => Promise<string>;

export interface AutomationScriptContext {
  /** Absolute path to the automation's scripts/ folder. */
  scriptsDir: string;
  /** Working directory for the script (the run's runs/<runId> folder). */
  cwd: string;
  /** Absolute path to the automation's durable out/ folder (CAIRN_OUT_DIR). */
  outDir: string;
  /** Extra env vars (CAIRN_* context, automation env). */
  env?: Record<string, string>;
  signal?: AbortSignal;
  onUpdate?: (output: string) => void;
  timeoutMs?: number;
}

// ── Interpreter resolution ────────────────────────────────────────────────────

type ScriptKind =
  | { kind: "node"; file: string }
  | { kind: "node-ts"; file: string }
  | { kind: "bash"; file: string }
  | { kind: "python"; file: string }
  | { kind: "cmd"; file: string }
  | { kind: "powershell"; file: string }
  | { kind: "direct"; file: string };

/** Script names are strictly bounded — no paths, no traversal, no shell chars. */
const SAFE_NAME = /^[\w.-]+$/;

const DEFAULT_TIMEOUT_MS = 120_000;
const UPDATE_THROTTLE_MS = 150;

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Resolve `name` to a concrete script file + interpreter kind. Throws with a
 * helpful message when nothing matches or multiple candidates exist.
 */
export function resolveScript(scriptsDir: string, name: string): ScriptKind {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`Invalid script name "${name}" — use only letters, digits, dots, dashes, and underscores.`);
  }
  const candidates: Array<{ label: string; kind: ScriptKind }> = [
    { label: name, kind: { kind: "direct", file: path.join(scriptsDir, name) } },
    { label: `${name}.js`, kind: { kind: "node", file: path.join(scriptsDir, `${name}.js`) } },
    { label: `${name}.ts`, kind: { kind: "node-ts", file: path.join(scriptsDir, `${name}.ts`) } },
    { label: `${name}.sh`, kind: { kind: "bash", file: path.join(scriptsDir, `${name}.sh`) } },
    { label: `${name}.py`, kind: { kind: "python", file: path.join(scriptsDir, `${name}.py`) } },
  ];
  if (process.platform === "win32") {
    candidates.push({ label: `${name}.bat`, kind: { kind: "cmd", file: path.join(scriptsDir, `${name}.bat`) } });
    candidates.push({ label: `${name}.cmd`, kind: { kind: "cmd", file: path.join(scriptsDir, `${name}.cmd`) } });
    candidates.push({ label: `${name}.ps1`, kind: { kind: "powershell", file: path.join(scriptsDir, `${name}.ps1`) } });
  }
  const found = candidates.filter((c) => fs.existsSync(c.kind.file));
  if (found.length === 0) {
    throw new Error(`Script "${name}" not found in ${scriptsDir}. Looked for: ${candidates.map((c) => c.label).join(", ")}.`);
  }
  if (found.length > 1) {
    throw new Error(`Ambiguous script "${name}" — ${found.map((c) => c.label).join(" and ")} both exist. Remove the extras.`);
  }
  return found[0].kind;
}

/**
 * The app's own Node runtime — spawn the Electron binary with
 * ELECTRON_RUN_AS_NODE=1 (the established pattern for the embeddings/runtime
 * servers). Works identically in dev and packaged, so no system-node lookup.
 */
function nodeCommand(): { cmd: string; electronAsNode: boolean } {
  return { cmd: process.execPath, electronAsNode: true };
}

// ── Execution ─────────────────────────────────────────────────────────────────

/** Build the spawn command + env for a resolved script kind. */
function buildSpawn(
  script: ScriptKind,
  scriptArgs: string[],
  env: Record<string, string>,
): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  switch (script.kind) {
    case "node":
    case "node-ts": {
      const { cmd, electronAsNode } = nodeCommand();
      if (electronAsNode) childEnv.ELECTRON_RUN_AS_NODE = "1";
      return { cmd, args: [script.file, ...scriptArgs], env: childEnv };
    }
    case "bash":
      return { cmd: getBashExecutable(), args: [script.file, ...scriptArgs], env: childEnv };
    case "python": {
      // win32: `python` resolves via the py launcher/PATHEXT; POSIX: python3.
      const cmd = process.platform === "win32" ? "python" : "python3";
      return { cmd, args: [script.file, ...scriptArgs], env: childEnv };
    }
    case "cmd":
      return { cmd: "cmd.exe", args: ["/d", "/c", script.file, ...scriptArgs], env: childEnv };
    case "powershell":
      return { cmd: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script.file, ...scriptArgs], env: childEnv };
    case "direct":
      return { cmd: script.file, args: scriptArgs, env: childEnv };
  }
}

/** Environment surfaced to every script (CAIRN_* context). */
export function scriptEnv(context: AutomationScriptContext): Record<string, string> {
  return {
    CAIRN_SCRIPTS_DIR: context.scriptsDir,
    CAIRN_OUT_DIR: context.outDir,
    ...(context.cwd ? { CAIRN_SCRATCH_DIR: context.cwd } : {}),
    ...(context.env ?? {}),
  };
}

/**
 * Run one named script and return its captured output. Resolves on exit code 0
 * (the output may be "(no output)"), rejects on non-zero exit, timeout, abort,
 * spawn failure, or unknown/ambiguous script.
 */
export async function runAutomationScript(
  args: RunScriptArgs,
  context: AutomationScriptContext,
): Promise<string> {
  const script = resolveScript(context.scriptsDir, args.name);
  const timeoutMs = args.timeout ? args.timeout * 1000 : context.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { cmd, args: spawnArgs, env } = buildSpawn(script, args.args ?? [], scriptEnv(context));
  const { signal, onUpdate } = context;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Script aborted"));
      return;
    }

    let output = "";
    let truncated = false;
    let lastUpdateMs = 0;
    const flushUpdate = () => { lastUpdateMs = Date.now(); onUpdate?.(output); };

    const child = spawn(cmd, spawnArgs, {
      cwd: context.cwd,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (child.pid) trackPid(child.pid);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (!truncated) {
        const available = DEFAULT_MAX_BYTES - Buffer.byteLength(output, "utf8");
        if (available <= 0) {
          truncated = true;
          output += `\n\n[Truncated: showed ${fmt(DEFAULT_MAX_BYTES)} of more. Use smaller script output.]`;
        } else {
          output += text.slice(0, available);
          if (Buffer.byteLength(text, "utf8") > available) truncated = true;
        }
      }
      if (Date.now() - lastUpdateMs >= UPDATE_THROTTLE_MS) flushUpdate();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const doKill = () => { if (child.pid) killProcessTree(child.pid); };

    const timer = setTimeout(() => {
      doKill();
      reject(new Error(`Script "${args.name}" timed out after ${args.timeout ?? timeoutMs / 1000} seconds\n\n${output}`));
    }, timeoutMs);

    const abortHandler = () => {
      clearTimeout(timer);
      flushUpdate();
      doKill();
      reject(new Error(`Script "${args.name}" aborted\n\n${output}`));
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      if (child.pid) untrackPid(child.pid);
      if (signal?.aborted) return; // already rejected above
      flushUpdate();
      if (code !== 0 && code !== null) {
        reject(new Error(`Script "${args.name}" exited with code ${code}\n\n${output}`));
      } else {
        resolve(output || "(no output)");
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      if (child.pid) untrackPid(child.pid);
      reject(new Error(`Failed to run script "${args.name}": ${err.message}`));
    });
  });
}

export const runScriptToolDefinition = {
  type: "function" as const,
  function: {
    name: RUN_SCRIPT_TOOL_NAME,
    description:
      "Run a named script from this automation's scripts/ folder. Scripts are resolved by name (exact, .js/.ts/.sh/.py, and on Windows .bat/.cmd/.ps1); the working directory is the run's scratch folder and CAIRN_OUT_DIR points at the durable out/ folder — copy anything worth keeping there. Use this for tools that need real code (image generation, data fetching, file processing).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Script name (e.g. \"generate_images\") — resolved inside the automation's scripts/ folder." },
        args: { type: "array", items: { type: "string" }, description: "Positional arguments passed to the script." },
        timeout: { type: "number", description: "Timeout in seconds (default 120)." },
      },
      required: ["name"],
    },
  },
};

// ── write_run_file — the agent→script data bridge ────────────────────────────
//
// The automation agent is data-only: it can fetch (connectors), reason, and
// call run_script, but it CANNOT write files. Scripts are real processes that
// CAN — so the recipe "fetch news → save JSON → run script -input file" needs a
// way for the agent to hand data to the script. write_run_file writes a file
// STRICTLY INSIDE the run's working folder (ephemeral, pruned) — a sandboxed
// scratch write, never a general file tool.

export interface WriteRunFileArgs {
  /** Relative path inside the run folder (subfolders auto-created). */
  path: string;
  /** File contents (e.g. a JSON document). */
  content: string;
}

export interface WriteRunFileContext {
  /** Absolute path to the run's working folder — the only writable root. */
  runDir: string;
}

export type WriteRunFileHandler = (args: WriteRunFileArgs) => Promise<string>;

/** Write a file inside the run folder. Rejects any path that escapes it. */
export async function writeRunFile(args: WriteRunFileArgs, ctx: WriteRunFileContext): Promise<string> {
  const rel = (args.path ?? "").trim();
  if (!rel) throw new Error("write_run_file requires a path");
  if (path.isAbsolute(rel) || rel.includes("\0") || rel.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid path "${rel}" — must be a relative path inside the run folder.`);
  }
  const root = path.resolve(ctx.runDir);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path "${rel}" escapes the run folder.`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = args.content ?? "";
  fs.writeFileSync(target, content, "utf8");
  return JSON.stringify({ ok: true, path: rel, bytes: Buffer.byteLength(content, "utf8") });
}

export const writeRunFileToolDefinition = {
  type: "function" as const,
  function: {
    name: WRITE_RUN_FILE_TOOL_NAME,
    description:
      "Save data to a file in the run's working folder (e.g. results from a connector) so a run_script can consume it. The file is written inside the run's scratch folder only — never anywhere else. Use it to stage input for run_script, e.g. save connector JSON then call run_script with '-input <file>'. Subfolders are created automatically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside the run folder, e.g. \"tavily_results.json\"." },
        content: { type: "string", description: "File contents (a JSON document for scripts to read)." },
      },
      required: ["path", "content"],
    },
  },
};
