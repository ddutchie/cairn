/**
 * Background shell jobs. A job belongs to the session that started it; the
 * registry lives for the process, so a job outlives the turn that began it.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { JobSummary } from "../../shared/agent/session-projection";

const KEEP_CHARS = 120_000;

export interface JobStart { owner: string; label: string; file: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }

interface Job extends JobSummary { output: string; kill(): void }

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();

  /** `changed` fires on every state change; `settled` once when a job ends. */
  constructor(private readonly hooks: { changed(owner: string): void; settled(job: JobSummary, tail: string): void }) {}

  start(s: JobStart): JobSummary {
    const id = `job-${randomUUID().slice(0, 8)}`;
    const child = spawn(s.file, s.args, { cwd: s.cwd, env: s.env ?? process.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const job: Job = {
      id, kind: "bash", label: s.label, status: "running", startedAt: Date.now(), ownerSession: s.owner, output: "",
      kill: () => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already gone */ } },
    };
    this.jobs.set(id, job);
    const onData = (d: Buffer) => { job.output += d.toString("utf8"); if (job.output.length > KEEP_CHARS) job.output = job.output.slice(-KEEP_CHARS); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const end = (status: JobSummary["status"], detail?: string) => {
      if (job.status === "completed" || job.status === "failed" || job.status === "killed") return;
      job.status = job.status === "stopping" ? "killed" : status;
      job.finishedAt = Date.now();
      if (detail) job.detail = detail;
      this.hooks.changed(s.owner);
      this.hooks.settled(this.summary(job), job.output.trimEnd().slice(-2_000));
    };
    child.on("error", (err) => end("failed", err.message));
    child.on("close", (code) => end(code === 0 ? "completed" : "failed", code === 0 ? undefined : `exit ${code}`));
    this.hooks.changed(s.owner);
    return this.summary(job);
  }

  private summary({ output: _o, kill: _k, ...rest }: Job): JobSummary { return { ...rest }; }

  list(owner?: string): JobSummary[] {
    return [...this.jobs.values()].filter((j) => owner === undefined || j.ownerSession === owner).map((j) => this.summary(j));
  }

  output(id: string, owner: string, tail = 4_000): { summary: JobSummary; text: string } | undefined {
    const job = this.jobs.get(id);
    if (!job || job.ownerSession !== owner) return undefined;
    return { summary: this.summary(job), text: job.output.slice(-tail) };
  }

  /** Stops a running job the caller owns; false when unknown, settled or someone else's. */
  kill(id: string, caller: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.ownerSession !== caller || job.status !== "running") return false;
    job.status = "stopping";
    this.hooks.changed(job.ownerSession);
    job.kill();
    return true;
  }

  /** Quit: stop every running job whoever owns it. */
  killEvery(): void {
    for (const j of this.jobs.values()) if (j.status === "running") { j.status = "stopping"; j.kill(); }
  }

  killAll(owner: string): void {
    for (const j of this.jobs.values()) if (j.ownerSession === owner && j.status === "running") { j.status = "stopping"; j.kill(); }
  }
}
