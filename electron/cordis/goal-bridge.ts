/**
 * goal-bridge — surface the dsh same-session goal (`ctx.goals`) in the Cairn UI.
 *
 * The model half is mounted post-bootstrap in `cordis-context.ts` (goal
 * service + `get_goal`/`create_goal`/`update_goal` tools + `/goal` command +
 * goal-round driver — all post-bootstrap because `GoalService` injects
 * `sessionProjections`, which only exists after the ProjectionRegistry
 * post-bootstrap mount; as ENTRY_LIST entries they would stall
 * `loader.await()` the same way `shell` would).
 *
 * This module is the UI half:
 *   - `mountGoalBridge` subscribes to `goal/changed` (the same event the
 *     upstream goal-round-driver listens to) and re-emits as
 *     `session:projection kind:"goal"` for the renderer chip. Singleton-
 *     subscribed (idempotent). Activation is process-local and deliberately
 *     omitted from the wire shape — the projection reflects durable phase
 *     only, matching dsh's own `goal` projection view.
 *   - `readGoalSnapshot` folds the session log on demand (live
 *     `snapshotEvents()` when the session is resident, else the durable
 *     prefix via `sessionPersistence.inspect`) through dsh's pure `foldGoal`,
 *     so the `session:goal` IPC handler needs no live agent and works right
 *     after a restart.
 */

import type { Context } from "@deepseek-ai/cordis";
import { foldGoal } from "@deepseek-ai/dsh-goal";
import type { GoalPhase } from "@deepseek-ai/dsh-goal";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  makeSessionProjection,
  type SessionProjectionKind,
} from "../../shared/agent/session-projection";

/** Renderer-safe goal summary (durable projection view — no activation). */
export interface GoalWire {
  id: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  blockedReason?: { code: string; message: string };
  roundsStarted: number;
  maxGoalRounds: number;
  createdAt: number;
  updatedAt: number;
}

interface GoalSnapshotLike {
  id?: unknown;
  revision?: unknown;
  objective?: unknown;
  phase?: unknown;
  blockedReason?: unknown;
  maxGoalRounds?: unknown;
}

interface FoldedGoalLike {
  goal?: GoalSnapshotLike;
  roundsStarted?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export function toGoalWire(folded: FoldedGoalLike | null | undefined): GoalWire | null {
  const goal = folded?.goal;
  if (!goal || typeof goal.id !== "string" || typeof goal.objective !== "string") return null;
  const wire: GoalWire = {
    id: goal.id,
    revision: typeof goal.revision === "number" ? goal.revision : 0,
    objective: goal.objective,
    phase: (typeof goal.phase === "string" ? goal.phase : "active") as GoalPhase,
    roundsStarted: typeof folded?.roundsStarted === "number" ? folded.roundsStarted : 0,
    maxGoalRounds: typeof goal.maxGoalRounds === "number" ? goal.maxGoalRounds : 0,
    createdAt: typeof folded?.createdAt === "number" ? folded.createdAt : 0,
    updatedAt: typeof folded?.updatedAt === "number" ? folded.updatedAt : 0,
  };
  const reason = goal.blockedReason as { code?: unknown; message?: unknown } | undefined;
  if (reason && typeof reason.code === "string" && typeof reason.message === "string") {
    wire.blockedReason = { code: reason.code, message: reason.message };
  }
  return wire;
}

/** Contexts already bridged — mount is idempotent across calls. */
const bridged = new WeakSet<object>();

export function __resetGoalBridgeForTest(): void {
  // WeakSet has no clear; tests use fresh fake contexts instead.
}

interface GoalChangedPayload {
  agent?: { session?: { id?: unknown } };
  change?: { operation?: unknown; goal?: GoalSnapshotLike & { roundsStarted?: unknown; createdAt?: unknown; updatedAt?: unknown } };
}

async function emitGoalChange(payload: GoalChangedPayload): Promise<void> {
  const sessionId = payload.agent?.session?.id;
  if (sessionId == null) return;
  const change = payload.change;
  // `clear` carries no goal — the chip hides (null), same as pre-create.
  const wire = change?.goal && typeof change.goal.id === "string"
    ? toGoalWire({
      goal: change.goal,
      roundsStarted: change.goal.roundsStarted,
      createdAt: change.goal.createdAt,
      updatedAt: change.goal.updatedAt,
    })
    : null;
  const { broadcastEvent } = await import("../ipc/registry");
  const kind: SessionProjectionKind = "goal";
  broadcastEvent(
    "session:projection",
    makeSessionProjection(String(sessionId), kind, {
      goal: wire,
      operation: typeof change?.operation === "string" ? change.operation : undefined,
    }),
  );
}

/**
 * Subscribe `goal/changed` notifications to `session:projection`.
 * Idempotent per context; call once from `getContext()` post-bootstrap,
 * after the goal stack is mounted.
 */
export function mountGoalBridge(ctx: Context): void {
  if (bridged.has(ctx)) return;
  bridged.add(ctx);
  const on = (ctx as unknown as { on?: (event: string, fn: (payload: GoalChangedPayload) => void) => unknown }).on;
  if (typeof on !== "function") {
    console.warn("[goal-bridge] ctx.on unavailable — goal UI will stay empty");
    return;
  }
  on.call(ctx, "goal/changed", (payload) => { void emitGoalChange(payload ?? {}); });
}

interface SessionLike {
  snapshotEvents?: () => Array<{ type?: unknown }>;
}

interface CordisLike {
  sessions?: { get?: (id: unknown) => SessionLike | undefined };
  sessionPersistence?: { inspect?: (id: unknown, signal?: AbortSignal) => Promise<{ events?: unknown }> };
}

/**
 * Fold the current goal for one session without requiring a live agent.
 * Live resident sessions fold their in-memory log (includes unflushed
 * mutations); otherwise the durable prefix is inspected. Returns null when
 * the session has no log or no current goal (pre-create / cleared).
 */
export async function readGoalSnapshot(ctx: Context, sessionId: string): Promise<GoalWire | null> {
  const cordis = ctx as unknown as CordisLike;
  const stableId = SessionId(sessionId);
  let events: unknown;
  try {
    const live = cordis.sessions?.get?.(stableId);
    if (live && typeof live.snapshotEvents === "function") {
      events = live.snapshotEvents();
    } else {
      const inspection = await cordis.sessionPersistence?.inspect?.(stableId);
      events = inspection?.events ?? [];
    }
  } catch {
    return null;
  }
  if (!Array.isArray(events)) return null;
  try {
    return toGoalWire(foldGoal(events as never) as FoldedGoalLike);
  } catch {
    return null;
  }
}
