/**
 * Gate — pending human approvals for every session, behind one registry.
 * See docs/plans/agent-engine-design.md §4 "The Gate".
 *
 *  - keyed (sessionId, callId) and guarded by a per-ask nonce, so a stale or
 *    forged response can never resolve another session's ask (audit G4)
 *  - `open()` registers the ask synchronously, so a transport that answers the
 *    instant it sees the event cannot race the waiter
 *  - every ask has a TTL and resolves fail-closed on timeout or abort (G6)
 *  - `pending()` is the snapshot a reconnecting renderer replays (G5)
 */
import { randomBytes } from "node:crypto";
import type { GrantKind, RiskClass } from "./rules";

export interface AskSpec {
  sessionId: string;
  callId: string;
  nonce: string;
  tool: string;
  risk: RiskClass;
  title: string;
  preview: string;
  /** Why we're asking: the rule, the doom-loop pause, the reviewer's reason. */
  reason: string;
  grants: GrantKind[];
  expiresAt: number;
}

export type AskInput = Omit<AskSpec, "nonce" | "expiresAt">;

export interface HumanDecision {
  approved: boolean;
  grant?: GrantKind;
}

export type GateOutcome =
  | { approved: boolean; by: "human"; grant?: GrantKind }
  | { approved: false; by: "timeout" | "abort" | "cleared" };

export const DEFAULT_ASK_TTL_MS = 10 * 60_000;

interface Pending {
  ask: AskSpec;
  settle: (outcome: GateOutcome) => void;
}

export class Gate {
  private readonly pendingMap = new Map<string, Pending>();
  private readonly listeners = new Set<(ask: AskSpec) => void>();

  private static key(sessionId: string, callId: string): string {
    return `${sessionId}::${callId}`;
  }

  /** Transports (desktop card, mobile, automation inbox) subscribe here. */
  onAsk(fn: (ask: AskSpec) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  open(input: AskInput, opts: { signal?: AbortSignal; ttlMs?: number } = {}): { ask: AskSpec; outcome: Promise<GateOutcome> } {
    const ttl = opts.ttlMs ?? DEFAULT_ASK_TTL_MS;
    const ask: AskSpec = { ...input, nonce: randomBytes(16).toString("hex"), expiresAt: Date.now() + ttl };
    const key = Gate.key(ask.sessionId, ask.callId);
    this.pendingMap.get(key)?.settle({ approved: false, by: "cleared" });

    const outcome = new Promise<GateOutcome>((resolve) => {
      const onAbort = () => settle({ approved: false, by: "abort" });
      const settle = (o: GateOutcome) => {
        if (this.pendingMap.get(key)?.ask.nonce === ask.nonce) this.pendingMap.delete(key);
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(o);
      };
      this.pendingMap.set(key, { ask, settle });
      const timer = setTimeout(() => settle({ approved: false, by: "timeout" }), ttl);
      timer.unref?.();
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
    });

    for (const fn of this.listeners) {
      try { fn(ask); } catch { /* a broken transport must not break the turn */ }
    }
    return { ask, outcome };
  }

  /** Resolve an ask from a transport. False when unknown, stale or forged. */
  resolve(sessionId: string, callId: string, nonce: string, decision: HumanDecision): boolean {
    const pending = this.pendingMap.get(Gate.key(sessionId, callId));
    if (!pending || pending.ask.nonce !== nonce) return false;
    const grant = decision.grant && pending.ask.grants.includes(decision.grant) ? decision.grant : undefined;
    pending.settle({ approved: decision.approved, by: "human", grant: decision.approved ? grant : undefined });
    return true;
  }

  pending(sessionId: string): AskSpec[] {
    return [...this.pendingMap.values()].filter((p) => p.ask.sessionId === sessionId).map((p) => p.ask);
  }

  /** Fail-closed teardown for session clear/destroy and app shutdown. */
  cancelSession(sessionId: string): void {
    for (const p of [...this.pendingMap.values()]) if (p.ask.sessionId === sessionId) p.settle({ approved: false, by: "cleared" });
  }

  clear(): void {
    for (const p of [...this.pendingMap.values()]) p.settle({ approved: false, by: "cleared" });
  }
}
