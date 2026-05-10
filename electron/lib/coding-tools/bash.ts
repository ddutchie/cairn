/**
 * bash tool — execute shell commands with streaming output + abort.
 *
 * Ported from pi packages/coding-agent/src/core/tools/bash.ts
 * Keeps: output truncation, abort signal, timeout, streaming onUpdate,
 *        process-group kill (sends SIGKILL to the entire process tree so
 *        child processes spawned by the command are also terminated),
 *        detached-PID tracking (so in-flight children are killed on app exit).
 */

import { spawn } from "child_process";

const MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

// ── Detached child PID tracking ───────────────────────────────────────────────
// Tracks PIDs of spawned children so they can be killed on app shutdown.

const trackedPids = new Set<number>();

function trackPid(pid: number): void { trackedPids.add(pid); }
function untrackPid(pid: number): void { trackedPids.delete(pid); }

/** Kill a process and all its children cross-platform. */
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
    } catch { /* ignore */ }
  } else {
    // Negative PID kills the entire process group
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Fallback: kill just the direct child if process-group kill fails
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  }
}

/** Called during Electron app shutdown to clean up any lingering children. */
export function killTrackedBashProcesses(): void {
  for (const pid of trackedPids) killProcessTree(pid);
  trackedPids.clear();
}

// ── Tool implementation ───────────────────────────────────────────────────────

export interface BashArgs {
  command: string;
  timeout?: number; // seconds
}

export interface BashOptions {
  onUpdate?: (output: string) => void;
  signal?: AbortSignal;
}

export async function bashTool(
  args: BashArgs,
  cwd: string,
  opts: BashOptions = {}
): Promise<string> {
  const { onUpdate, signal } = opts;
  const timeoutMs = args.timeout ? args.timeout * 1000 : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Command aborted"));
      return;
    }

    let output = "";
    let truncated = false;

    const child = spawn("bash", ["-c", args.command], {
      cwd,
      // detached: true creates a new process group so process.kill(-pid) reaches
      // all children spawned by the command, not just the direct bash process.
      detached: process.platform !== "win32",
      env: { ...process.env, TERM: "xterm-256color" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (child.pid) trackPid(child.pid);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (!truncated) {
        const available = MAX_OUTPUT_BYTES - Buffer.byteLength(output, "utf8");
        if (available <= 0) {
          truncated = true;
          output += "\n[Output truncated — exceeded 50 KB limit]";
        } else {
          output += text.slice(0, available);
          if (Buffer.byteLength(text, "utf8") > available) {
            truncated = true;
            output += "\n[Output truncated — exceeded 50 KB limit]";
          }
        }
      }
      onUpdate?.(output);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const doKill = () => {
      if (child.pid) killProcessTree(child.pid);
    };

    const timer = setTimeout(() => {
      doKill();
      reject(new Error(`Command timed out after ${args.timeout ?? DEFAULT_TIMEOUT_MS / 1000} seconds\n\n${output}`));
    }, timeoutMs);

    const abortHandler = () => {
      clearTimeout(timer);
      doKill();
      reject(new Error(`Command aborted\n\n${output}`));
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      if (child.pid) untrackPid(child.pid);
      if (signal?.aborted) return; // already rejected above
      if (code !== 0 && code !== null) {
        reject(new Error(`Command exited with code ${code}\n\n${output}`));
      } else {
        resolve(output || "(no output)");
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      if (child.pid) untrackPid(child.pid);
      reject(new Error(`Failed to execute command: ${err.message}`));
    });
  });
}

export const bashToolDefinition = {
  type: "function" as const,
  function: {
    name: "bash",
    description:
      "Execute a bash command in the project's root directory. " +
      "Output is streamed and capped at 50 KB. " +
      "Use for running tests, builds, grep, git commands, etc. " +
      "Avoid interactive commands or long-running processes.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (default: 120)" },
      },
      required: ["command"],
    },
  },
};
