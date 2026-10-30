/**
 * Shell execution. Runs through the user's shell with a timeout, abort support
 * and bounded output. NOTE: unlike the dsh stack there is no OS sandbox here
 * yet — the permission pipeline is the only guard, and EXEC asks by default.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import type { JobRegistry } from "../jobs";
import { clampMiddle, fail, ok } from "./schema";

export interface BashDeps {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** When set, `run_in_background` is offered and jobs are owned by `jobs.owner`. */
  jobs?: { registry: JobRegistry; owner: string };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;
const KEEP_BYTES = 4 * MAX_OUTPUT_CHARS;

function shellFor(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  return { file: process.env.SHELL && /\/(ba|z)?sh$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/bash", args: ["-c", command] };
}

export function bashTool(deps: BashDeps): AgentTool {
  return defineTool({
    name: "bash",
    description: process.platform === "win32"
      ? "Run a PowerShell command in the session working directory. Output is combined stdout/stderr."
      : "Run a bash command in the session working directory. Output is combined stdout/stderr.",
    parameters: Type.Object({
      command: Type.String({ description: "The command to execute." }),
      description: Type.String({ description: "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI)." }),
      timeoutMs: Type.Optional(Type.Number({ description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). The command is killed on expiry.` })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Start the command as a background job and return its id immediately; check on it with job_output." })),
      workdir: Type.Optional(Type.String({ description: "Working directory; relative paths resolve against the session working directory." })),
    }),
    risk: (a) => ({ class: "EXEC", command: a.command, paths: a.workdir ? [path.resolve(deps.cwd, a.workdir)] : undefined }),
    preview: (a) => a.command,
    execute(a, ctx) {
      const cwd = a.workdir ? path.resolve(deps.cwd, a.workdir) : deps.cwd;
      const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(a.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
      const { file, args } = shellFor(a.command);
      if (a.run_in_background && deps.jobs) {
        const job = deps.jobs.registry.start({ owner: deps.jobs.owner, label: a.description || a.command, file, args, cwd, env: deps.env });
        return Promise.resolve(ok(`Started background job ${job.id}. Use job_output to read it and job_kill to stop it.`));
      }
      return new Promise((resolve) => {
        let out = "";
        let timedOut = false;
        const child = spawn(file, args, { cwd, env: deps.env ?? process.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
        const kill = () => {
          try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already gone */ }
        };
        const onData = (d: Buffer) => { out += d.toString("utf8"); if (out.length > KEEP_BYTES) out = out.slice(-KEEP_BYTES); };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
        const onAbort = () => kill();
        ctx.signal?.addEventListener("abort", onAbort, { once: true });
        const done = (result: ReturnType<typeof ok>) => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };
        child.on("error", (err) => done(fail(`Failed to start shell: ${err.message}`)));
        child.on("close", (code, signal) => {
          const body = clampMiddle(out.trimEnd(), MAX_OUTPUT_CHARS);
          if (ctx.signal?.aborted) return done(fail(`${body}\n[aborted]`.trim()));
          if (timedOut) return done(fail(`${body}\n[timed out after ${timeout}ms and was killed]`.trim()));
          if (code === 0) return done(ok(body || "(no output)"));
          done(fail(`${body}\n[exit ${code ?? signal}]`.trim()));
        });
      });
    },
  });
}
