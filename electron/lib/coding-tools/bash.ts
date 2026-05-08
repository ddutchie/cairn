/**
 * bash tool — execute shell commands with streaming output + abort.
 *
 * Ported from pi packages/coding-agent/src/core/tools/bash.ts
 * Keeps: output truncation, abort signal, timeout, streaming onUpdate.
 * Removed: TUI rendering, TypeBox schemas, pluggable Operations.
 */

import { spawn } from "child_process";

const MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

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
      env: { ...process.env, TERM: "xterm-256color" },
      stdio: ["ignore", "pipe", "pipe"],
    });

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

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${args.timeout ?? DEFAULT_TIMEOUT_MS / 1000} seconds\n\n${output}`));
    }, timeoutMs);

    const abortHandler = () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error(`Command aborted\n\n${output}`));
    };
    signal?.addEventListener("abort", abortHandler);

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
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
