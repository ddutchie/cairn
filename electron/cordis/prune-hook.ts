import type { Context } from "@deepseek-ai/cordis";
import { getContext } from "./cordis-context";

/**
 * Guard that prevents pruning while a compaction is in flight for a session.
 * Bridged via the `compaction/start` / `compaction/end` session events emitted
 * by BasicCompactionEngine. Mirrors the `assertNoActiveCompaction` check
 * inside compaction-basic but for the manual pruneSession path.
 */
const activeCompactions = new Set<string>();
let guardMounted = false;

export function mountPruneGuard(ctx: Context): void {
  if (guardMounted) return;
  guardMounted = true;
  (ctx as unknown as { on: (event: string, handler: (session: unknown, event: unknown) => void) => () => void }).on(
    "session/event",
    (session: unknown, event: unknown) => {
      const type = (event as { type?: string })?.type;
      const id = String((session as { id?: unknown })?.id ?? "");
      if (!id) return;
      if (type === "compaction/start") activeCompactions.add(id);
      else if (type === "compaction/end") activeCompactions.delete(id);
    },
  );
}

export function isPruneBlocked(sessionId: string): boolean {
  return activeCompactions.has(sessionId);
}

/**
 * Try to prune over-budget tool results for the given agent's session.
 * - No-op when the pruner service is not mounted.
 * - No-op when a compaction is active for the session (guarded via start/end).
 * - No-op when the session has no open turn (pruneSession requires an open turn;
 *   idle after turn/end will be skipped until the next open turn).
 * - Surfaces PruneResult.charsRemoved via the pi-agent bridge as a
 *   compaction/prune telemetry trace when positive, otherwise silent.
 *
 * Intended to be called ONCE per idle transition (after whenIdle) and/or
 * optionally before the 0.8 pressure check. It lowers pressure before the
 * summarizer decides to compact. The compaction engine itself also calls
 * prune internally before its threshold, so this hook is an opportunistic
 * pre-pass that reduces the need for summarization.
 */
export async function tryPruneSession(agent: { session: { id: unknown; surface: unknown; events: unknown[] } }): Promise<{ pruned: number; charsRemoved: number } | null> {
  const sessionId = String((agent.session as { id?: unknown }).id ?? "");
  if (isPruneBlocked(sessionId)) return null;
  let ctx: Context;
  try {
    ctx = await getContext();
  } catch {
    return null;
  }
  // Mount guard lazily if not yet mounted (e.g. tests that bypass getContext's mount path).
  try {
    mountPruneGuard(ctx);
  } catch { /* best-effort */ }

  const pruner = (ctx as unknown as { toolResultPruner?: { pruneSession: (s: unknown) => { pruned: unknown[]; charsRemoved: number } } }).toolResultPruner
    ?? (ctx as unknown as { get: (name: string) => unknown }).get?.("toolResultPruner") as { pruneSession: (s: unknown) => { pruned: unknown[]; charsRemoved: number } } | undefined;
  if (!pruner || typeof pruner.pruneSession !== "function") return null;

  // Prune requires an open turn (invariant registry enforces this). If the
  // session is idle with no open turn, skip — the next turn's pre-step will
  // prune before the 0.8 check.
  try {
    const result = pruner.pruneSession(agent.session as never);
    if (result.charsRemoved > 0) {
      // Surface via the existing session/event → cairnCodingPlugin bridge:
      // the prune phase itself already emitted `compaction/prune` shadow-price
      // events, but we also log the aggregate for the pi-agent bridge /
      // diagnostics. The compaction plugin's `compact` projection is owned by
      // summarization; pruning is complementary and reported separately.
      try {
        (ctx as unknown as { logger?: { info: (msg: string) => void } }).logger?.info?.(
          `tool-result-prune: pruned ${result.pruned.length} tool results, ${result.charsRemoved} chars removed (session ${sessionId})`,
        );
      } catch { /* logging is optional */ }
    }
    return { pruned: result.pruned.length, charsRemoved: result.charsRemoved };
  } catch (err) {
    // Common benign cases: "outside any open turn" when called at idle after
    // turn/end, or "active compaction" if raced. Never break the turn over
    // pruning.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("outside any open turn") || msg.includes("active compaction") || msg.includes("while compaction")) {
      return null;
    }
    console.warn(`[prune-hook] pruneSession failed for ${sessionId}:`, msg);
    return null;
  }
}
