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
import { DEFAULT_MAX_BYTES, getBashExecutable, killTree as killProcessTree, trackPid, untrackPid } from "../proc";
import { assertCommandNotReadingSecrets } from "./secrets";
import { formatBytesBinary } from "../../../shared/format/number";

// Byte formatter for streaming truncation hints (shared, see F14).
function fmt(bytes: number): string {
  return formatBytesBinary(bytes);
}

const MAX_OUTPUT_BYTES = DEFAULT_MAX_BYTES;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

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

  // First line of defence against secret exfiltration through the shell — a
  // conservative token scan. (The proper control is per-command user approval;
  // see the follow-up task.)
  assertCommandNotReadingSecrets(args.command);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Command aborted"));
      return;
    }

    let output = "";
    let truncated = false;
    // Throttle live label updates: one IPC event per stdout/stderr chunk would
     // flood the renderer (each becomes a full tool projection + React
    // re-render). Coalesce to a bounded cadence; a final update is flushed when
    // the process closes so the chip still ends on the final output.
    let lastUpdateMs = 0;
    const UPDATE_THROTTLE_MS = 150;
    const flushUpdate = () => { lastUpdateMs = Date.now(); onUpdate?.(output); };

    const bashExe = getBashExecutable();
    const child = spawn(bashExe, ["-c", args.command], {
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
          output += `\n\n[Truncated: showed ${fmt(MAX_OUTPUT_BYTES)} of ${fmt(Buffer.byteLength(output, "utf8"))}. Use offset/limit to page.]`;
        } else {
          output += text.slice(0, available);
          if (Buffer.byteLength(text, "utf8") > available) {
            truncated = true;
            output += `\n\n[Truncated: showed ${fmt(MAX_OUTPUT_BYTES)} of more. Use offset/limit to page.]`;
          }
        }
      }
      if (Date.now() - lastUpdateMs >= UPDATE_THROTTLE_MS) flushUpdate();
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
      // Flush throttled output BEFORE rejecting so the live chip label shows
      // the final bytes when the tool ends as aborted. (Not in the close
      // handler's aborted branch — reject() resolves the loop's await first and
      // fires onToolEnd, so flushing there would emit an out-of-order label
      // update that re-adds a running chip.)
      flushUpdate();
      doKill();
      reject(new Error(`Command aborted\n\n${output}`));
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      if (child.pid) untrackPid(child.pid);
      if (signal?.aborted) return; // already rejected above
      // Flush the final output so the live chip label ends on the last bytes.
      flushUpdate();
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
      `Output is streamed and capped at ${MAX_OUTPUT_BYTES / 1000}KB. ` +
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
