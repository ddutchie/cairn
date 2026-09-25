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
 * Ownership fence (dsh-jobs 0.1.7): jobs are owned by a SessionId, and
 * `list` / `kill` take that session id as the caller. Every event re-lists the
 * affected owner's jobs through that id, and the owner is remembered per live
 * job so the renderer's Kill button can pass the fence. Kill additionally
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
  owner?: unknown;
}

type JobEventLike = { type: string; job?: JobSnapshotLike; id?: unknown; owner?: unknown };

interface JobRegistryLike {
  list: (caller?: unknown) => JobSnapshotLike[];
  kill: (id: string, caller?: unknown, reason?: string) => unknown;
  events: { subscribe: (filter: { owners: "all" }, listener: (event: JobEventLike) => void) => () => void };
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "killed", "failed"]);

/** Contexts already bridged — mount is idempotent across turns. */
const bridged = new WeakSet<object>();
/** ENTRY_LIST-singleton registry, captured at mount for the kill path. */
let liveRegistry: JobRegistryLike | undefined;
/**
 * Owner session id per live job id (the fence caller for kill), mirroring the
 * dock visibility rule (a pane shows a job iff it is unowned or its own).
 * Unowned jobs map to undefined and stay killable by any session showing them.
 * Pruned once the job settles.
 */
const sessionByJob = new Map<string, string | undefined>();

export function __resetJobsBridgeForTest(): void {
  liveRegistry = undefined;
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
  if (snap.owner != null) summary.ownerSession = String(snap.owner);
  return summary;
}

async function emitJobs(jobs: JobRegistryLike, ownerSession: string | undefined): Promise<void> {
  let snaps: JobSnapshotLike[];
  try {
    snaps = jobs.list(ownerSession);
  } catch (err) {
    console.warn("[jobs-bridge] list failed:", err instanceof Error ? err.message : err);
    return;
  }
  const summaries = snaps.map(toSummary);
  // Remember owners for live jobs (kill path); prune settled ones.
  for (const s of summaries) {
    if (TERMINAL.has(s.status)) sessionByJob.delete(s.id);
    else sessionByJob.set(s.id, s.ownerSession);
  }
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
  if (!jobs || typeof jobs.events?.subscribe !== "function") {
    console.warn("[jobs-bridge] ctx.jobs unavailable — background-job UI will stay empty");
    return;
  }
  liveRegistry = jobs;
  jobs.events.subscribe({ owners: "all" }, (event) => {
    // Output chunks don't change the dock's list; every other event does.
    if (event.type === "output") return;
    const owner = event.job?.owner ?? event.owner;
    void emitJobs(jobs, owner != null ? String(owner) : undefined);
  });
}

/**
 * Kill a background job past the ownership fence using the remembered owner
 * session. Kills are allowed under exactly the dock visibility rule (owner
 * is undefined, or equals the requester). Anything else throws `not-owner` —
 * cross-session stops are rejected even though the renderer is first-party,
 * so a pane can never terminate another session's work. Jobs the bridge has
 * not seen live (settled or unknown) fail `owner-unavailable`; anything else
 * is the registry's own error. All surfacing as `{ok:false, code}` IPC.
 */
export function killJob(jobId: string, requesterSessionId: string): unknown {
  if (!liveRegistry) throw Object.assign(new Error("jobs registry unavailable"), { code: "registry-unavailable" });
  if (!sessionByJob.has(jobId)) {
    throw Object.assign(new Error(`no live owner for job ${jobId} (job settled or unknown)`), {
      code: "owner-unavailable",
    });
  }
  const ownerSession = sessionByJob.get(jobId);
  if (ownerSession !== undefined && ownerSession !== requesterSessionId) {
    throw Object.assign(new Error(`job ${jobId} is owned by session ${ownerSession}`), {
      code: "not-owner",
    });
  }
  return liveRegistry.kill(jobId, ownerSession, "stopped from the Cairn jobs dock");
}
