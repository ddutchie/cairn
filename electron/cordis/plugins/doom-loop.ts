/**
 * cairn:doom-loop — bundled HITL plugin (PILOT for the user-space shape).
 *
 * First consumer of `ctx.cairn.confirm()`: the plugin touches no app-internal
 * IPC wiring (no send/registerPending) — only the public host seam plus its
 * own tools/pre-execute guard. When a model issues the SAME tool with
 * IDENTICAL arguments this many times in a row, pause and ask the user to
 * continue before it burns the step budget.
 *
 * UX note: the ask renders through the standard approval-card pipeline (risk
 * label/grants from shared/agent/tool-risk) instead of the old bespoke banner.
 * "Allow" continues the repeated call once and stops re-pausing this session;
 * deny/timeouts halt the loop.
 *
 * Sessions without a bound transport (e.g. headless automation runs) get
 * deterministic protection: confirm resolves "cancelled" → the repeated call
 * is denied and the turn halts rather than spinning unattended.
 */

import type { Context } from "@deepseek-ai/cordis";

/** Repeated-identical-call threshold before pausing. */
export const DOOM_LOOP_THRESHOLD = 3;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function toolCallSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(canonicalize(args))}`;
}

type ConfirmFn = (
  sessionId: string,
  req: { title?: string; detail?: string; toolName?: string; args?: Record<string, unknown> },
  opts?: { signal?: AbortSignal },
) => Promise<"allowed-once" | "rejected" | "cancelled">;

export interface CairnDoomLoopConfig {
  /** The caller's pi sessionId — scopes the confirm call. */
  sessionId: string;
  signal?: AbortSignal;
  /** Override the default DOOM_LOOP_THRESHOLD. */
  threshold?: number;
}

export function cairnDoomLoopPlugin(ctx: Context, config: CairnDoomLoopConfig): (() => void) | void {
  const { sessionId, signal, threshold = DOOM_LOOP_THRESHOLD } = config;

  // Pilot contract: consume only the public host seam. Without one (plugin
  // mounted outside an interactive session) stay inert rather than block on an
  // answerable-by-nobody ask — EXCEPT the headless case below, where confirm()
  // itself fails closed to "cancelled".
  const confirm = (ctx as unknown as { cairn?: { confirm?: ConfirmFn } }).cairn?.confirm;
  if (!confirm) return;

  const recent: string[] = [];
  // Thresholds matching dsh's repeat-tool-reminder: 3,5,8 — each is a nudge, not a permanent block.
  const thresholds = threshold === DOOM_LOOP_THRESHOLD ? [3, 5, 8] : [threshold];
  let lastPromptedAt = 0;

  type PreHandler = (...args: unknown[]) => Promise<unknown> | unknown;
  // Reset on new user input so a loop in one turn doesn't poison the next.
  const unsubReset = (ctx as unknown as { on: (ev: string, fn: (...a: unknown[]) => unknown) => () => void }).on(
    "agent/pre-step" as string,
    (...a: unknown[]) => {
      const data = a[0] as { source?: { kind?: string } } | undefined;
      if (data?.source?.kind === "user") {
        recent.length = 0;
        lastPromptedAt = 0;
      }
    },
  );
  const unsub = (ctx as unknown as { on: (ev: string, fn: PreHandler) => () => void }).on(
    "tools/pre-execute",
    async (...args: unknown[]) => {
      const exec = args[0] as { name?: string; arguments?: unknown } | undefined;
      const next = args[1] as (() => Promise<unknown>) | undefined;
      const name = exec?.name;
      if (typeof name !== "string") return next ? next() : undefined;

      const argsObj = (exec?.arguments && typeof exec.arguments === "object") ? exec.arguments as Record<string, unknown> : {};
      const sig = toolCallSignature(name, argsObj);

      // Determine if this call completes a threshold streak.
      // We consider the streak length including this call, so for threshold 3 we need 3 consecutive identical sigs.
      const streakLen = (() => {
        let n = 1;
        for (let i = recent.length - 1; i >= 0 && recent[i] === sig; i--) n++;
        return n;
      })();
      const shouldPrompt = thresholds.includes(streakLen) && streakLen !== lastPromptedAt;

      if (shouldPrompt) {
        const outcome = await confirm(
          sessionId,
          {
            title: `"${name}" is repeating`,
            detail: `Called ${streakLen}× in a row with identical arguments — this looks like a loop.`,
            toolName: name,
            args: argsObj,
          },
          { signal },
        );
        recent.push(sig);
        if (recent.length > 20) recent.shift();
        if (outcome !== "allowed-once") {
          return {
            kind: "deny",
            reason: outcome === "rejected"
              ? "Stopped: repeated identical tool call (possible loop). Halted by the user."
              : "Stopped: no response to the repeat-detection pause within the time limit. Halted as a precaution — re-prompt to continue.",
          };
        }
        lastPromptedAt = streakLen;
        return next ? next() : undefined;
      }
      recent.push(sig);
      if (recent.length > 20) recent.shift();
      return next ? next() : undefined;
    },
  );
  return () => { try { unsubReset(); } catch { /* noop */ } try { unsub(); } catch { /* noop */ } };
}
