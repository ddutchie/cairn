/**
 * Shell execution. Runs through the user's shell with a timeout, abort support
 * and bounded output. Commands run inside the OS sandbox (see ../sandbox.ts)
 * unless the model asks for `unsandboxed`, which always goes to the human.
 */
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import type { JobRegistry } from "../jobs";
import { platformShell, runProcess } from "../../lib/proc";
import { sandboxDenialHint, sandboxStatus, sandboxUnavailable, wrapSandboxed, type SandboxOptions } from "../sandbox";
import { clampMiddle, fail, ok } from "./schema";

export interface BashDeps {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** When set, `run_in_background` is offered and jobs are owned by `jobs.owner`. */
  jobs?: { registry: JobRegistry; owner: string };
  /** Confinement for commands; omitted means unconfined (tests, automation-dev). */
  sandbox?: SandboxOptions | (() => SandboxOptions);
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;
const KEEP_BYTES = 4 * MAX_OUTPUT_CHARS;

export function bashTool(deps: BashDeps): AgentTool {
  // Read per call so toggling the setting applies to the next command, not the next session.
  const sandboxOf = (): SandboxOptions | undefined => (typeof deps.sandbox === "function" ? deps.sandbox() : deps.sandbox);
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
      unsandboxed: Type.Optional(Type.Boolean({ description: "Run outside the sandbox (which limits writes to the working directory and temp dirs). Only after a sandboxed attempt failed because of it; the user is asked every time." })),
      reason: Type.Optional(Type.String({ description: "With unsandboxed: why this command must run outside the sandbox. Shown to the user when they are asked." })),
    }),
    risk: (a) => {
      const sb = sandboxOf();
      // Leaving the sandbox, or running with a sandbox that is on but cannot start, is the human's call.
      const broken = sb && sandboxUnavailable(sb.mode);
      const leaving = sb && a.unsandboxed && sandboxStatus(sb.mode).active;
      const escalation = Boolean(leaving || broken);
      return {
        class: "EXEC", command: a.command, paths: a.workdir ? [path.resolve(deps.cwd, a.workdir)] : undefined,
        // Plan mode may run it: the sandbox is up and this call stays inside it.
        ...(sb && !a.unsandboxed && sandboxStatus(sb.mode).active ? { confinable: true } : {}),
        ...(escalation ? { escalation: true, escalationReason: `${a.unsandboxed ? (a.reason?.trim() || "(no reason given)") : `the sandbox is unavailable (${broken})`} — ${a.command}` } : {}),
      };
    },
    preview: (a) => a.command,
    execute(a, ctx) {
      // Plan mode: the policy let this through only because it can be confined read-only; never run it any other way.
      if (ctx.readOnly && (a.unsandboxed || !sandboxOf() || !sandboxStatus(sandboxOf()!.mode).active)) return Promise.resolve(fail("Plan mode only allows shell commands inside the read-only sandbox, which is not available."));
      const cwd = a.workdir ? path.resolve(deps.cwd, a.workdir) : deps.cwd;
      const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(a.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
      const raw = platformShell(a.command);
      const { file, args } = sandboxOf() && !a.unsandboxed ? wrapSandboxed(raw, cwd, { ...sandboxOf()!, ...(ctx.readOnly ? { mode: "read-only" as const } : {}), root: deps.cwd }) : raw;
      if (a.run_in_background && deps.jobs) {
        const job = deps.jobs.registry.start({ owner: deps.jobs.owner, label: a.description || a.command, file, args, cwd, env: deps.env });
        return Promise.resolve(ok(`Started background job ${job.id}. Use job_output to read it and job_kill to stop it.`));
      }
      return runProcess({
        file, args, cwd, env: deps.env ?? process.env,
        timeoutMs: timeout, signal: ctx.signal,
        maxChars: KEEP_BYTES, keep: "tail", combine: true,
      }).then((r) => {
        if (r.error) return fail(`Failed to start shell: ${r.error}`);
        const body = clampMiddle(r.stdout.trimEnd(), MAX_OUTPUT_CHARS);
        const hint = r.code !== 0 && sandboxOf() && !a.unsandboxed ? sandboxDenialHint(r.stdout, ctx.readOnly) : undefined;
        if (r.aborted) return fail(`${body}\n[aborted]`.trim());
        if (r.timedOut) return fail(`${body}\n[timed out after ${timeout}ms and was killed]`.trim());
        if (r.code === 0) return ok(body || "(no output)");
        return fail(`${body}\n[exit ${r.code ?? r.signal}]${hint ? `\n${hint}` : ""}`.trim());
      });
    },
  });
}
