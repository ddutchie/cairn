/**
 * jobs-bridge — surface dsh background jobs (`ctx.jobs`) in the Cairn UI.
 *
 * The model half is mounted in ENTRY_LIST (`jobs-local` + `cairn:tool-jobs`):
 * one-shot `run_in_background` and continuable `delegate` both register here.
 * Without this bridge, completions only reach the model inbox — the user never
 * sees the list, progress, or terminal state. This subscribes once per process
 * (the registry is an ENTRY_LIST singleton, outliving any turn) and re-emits
 * as `session:projection kind:"jobs"` for the renderer dock.
 *
 * Ownership fence: jobs owned by an agent are only visible to that agent, so
 * every emission re-lists through the owner the notification arrived with
 * (`onJobsChanged(owner)` / `onJobDone(snapshot, owner)`). The owner is also
 * stashed per job id so the renderer's Kill button can call `kill(id, owner)`
 * past the fence; entries are pruned once the job settles. Kill additionally
 * binds to the requesting session id — a pane can only stop jobs its dock
 * would show (unowned, or its own).
 */

import type { Context } from "@deepseek-ai/cordis";
import {
  makeSessionProjection,
  type JobSummary,
  type SessionProjectionKind,
} from "../../shared/agent/session-projection";

type JobStatus = JobSummary["status"];

interface JobSnapshotLike {
  id: unknown;
  kind: unknown;
  label: unknown;
  status: unknown;
  detail?: unknown;
  startedAt: unknown;
  finishedAt?: unknown;
  ownerSession?: unknown;
}

interface JobRegistryLike {
  list: (caller?: unknown) => JobSnapshotLike[];
  kill: (id: string, caller?: unknown) => unknown;
  onJobsChanged: (listener: (owner: unknown) => void) => () => void;
  onJobDone: (listener: (snapshot: JobSnapshotLike, owner: unknown) => void) => () => void;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "killed", "failed"]);

/** Contexts already bridged — mount is idempotent across turns. */
const bridged = new WeakSet<object>();
/** ENTRY_LIST-singleton registry, captured at mount for the kill path. */
let liveRegistry: JobRegistryLike | undefined;
/** Owner agent per live job id, for fence-passing kill calls. Pruned on settle. */
const ownerByJob = new Map<string, unknown>();
/**
 * Owner session id per live job id, for the session binding on kill.
 * Mirrors the dock visibility rule (a pane shows a job iff its ownerSession
 * is null or its own): a kill is allowed under exactly the same condition.
 * Unowned jobs (undefined — snapshots without ownerSession) stay killable by
 * any session showing them; anything else must match the requesting session.
 * Pruned alongside ownerByJob.
 */
const sessionByJob = new Map<string, string | undefined>();

export function __resetJobsBridgeForTest(): void {
  liveRegistry = undefined;
  ownerByJob.clear();
  sessionByJob.clear();
}

function toSummary(snap: JobSnapshotLike): JobSummary {
  const status = String(snap.status);
  const summary: JobSummary = {
    id: String(snap.id),
    kind: String(snap.kind ?? "unknown"),
    label: String(snap.label ?? snap.id),
    status: (status === "stopping" || TERMINAL.has(status) ? status : "running") as JobStatus,
    startedAt: typeof snap.startedAt === "number" ? snap.startedAt : Date.now(),
  };
  if (typeof snap.detail === "string" && snap.detail) summary.detail = snap.detail;
  if (typeof snap.finishedAt === "number") summary.finishedAt = snap.finishedAt;
  if (snap.ownerSession != null) summary.ownerSession = String(snap.ownerSession);
  return summary;
}

async function emitJobs(jobs: JobRegistryLike, owner: unknown): Promise<void> {
  let snaps: JobSnapshotLike[];
  try {
    snaps = jobs.list(owner ?? undefined);
  } catch (err) {
    console.warn("[jobs-bridge] list failed:", err instanceof Error ? err.message : err);
    return;
  }
  const summaries = snaps.map(toSummary);
  // Stash owners for live jobs (kill path); prune settled ones.
  for (const s of summaries) {
    if (TERMINAL.has(s.status)) {
      ownerByJob.delete(s.id);
      sessionByJob.delete(s.id);
    } else if (owner !== undefined) {
      ownerByJob.set(s.id, owner);
      sessionByJob.set(s.id, s.ownerSession);
    }
  }
  // Prefer the snapshots' own ownerSession; fall back to the notifying agent.
  const agent = owner as { session?: { id?: unknown } } | undefined;
  const ownerSession =
    summaries.find((s) => s.ownerSession != null)?.ownerSession ??
    (agent?.session?.id != null ? String(agent.session.id) : undefined);
  const { broadcastEvent } = await import("../ipc/registry");
  const kind: SessionProjectionKind = "jobs";
  broadcastEvent(
    "session:projection",
    makeSessionProjection(ownerSession ?? "jobs", kind, { ownerSession, jobs: summaries }),
  );
}

/**
 * Subscribe `ctx.jobs` change/completion notifications to `session:projection`.
 * Idempotent per context; call once from `getContext()` post-bootstrap.
 */
export function mountJobsBridge(ctx: Context): void {
  if (bridged.has(ctx)) return;
  bridged.add(ctx);
  const jobs = (ctx as unknown as { jobs?: JobRegistryLike }).jobs;
  if (!jobs || typeof jobs.onJobsChanged !== "function" || typeof jobs.onJobDone !== "function") {
    console.warn("[jobs-bridge] ctx.jobs unavailable — background-job UI will stay empty");
    return;
  }
  liveRegistry = jobs;
  jobs.onJobsChanged((owner) => { void emitJobs(jobs, owner); });
  jobs.onJobDone((_snapshot, owner) => { void emitJobs(jobs, owner); });
}

/**
 * Kill a background job past the ownership fence using the stashed owner.
 * The requesting session must own the job: kills are allowed under exactly
 * the dock visibility rule (stashed ownerSession is null/undefined, or
 * equals the requester). Anything else throws `not-owner` — cross-session
 * stops are rejected even though the renderer is first-party, so a pane can
 * never terminate another session's work. Unowned jobs (owner turn ended or
 * job settled) still fail `owner-unavailable`; anything else is the
 * registry's own error. All surfacing as `{ok:false, code}` IPC.
 */
export function killJob(jobId: string, requesterSessionId: string): unknown {
  if (!liveRegistry) throw Object.assign(new Error("jobs registry unavailable"), { code: "registry-unavailable" });
  const owner = ownerByJob.get(jobId);
  if (owner === undefined) {
    throw Object.assign(new Error(`no live owner for job ${jobId} (owner turn ended or job settled)`), {
      code: "owner-unavailable",
    });
  }
  const stashedSession = sessionByJob.get(jobId);
  if (stashedSession !== undefined && stashedSession !== requesterSessionId) {
    throw Object.assign(new Error(`job ${jobId} is owned by session ${stashedSession}`), {
      code: "not-owner",
    });
  }
  return liveRegistry.kill(jobId, owner);
}
