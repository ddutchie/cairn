/**
 * ctx.cairn.confirm() — the host confirmation seam for plugins.
 *
 * A user-space/bundled plugin cannot reach Electron IPC or Cairn's pending
 * maps; it asks the HOST to confirm on its behalf. The host routes the ask
 * through whichever transport fits the session — today the interactive coding
 * surface (synthetic pending chip + approval card + respond IPC), tomorrow
 * headless automation or mobile.
 *
 * Design notes:
 *  - Reuses the NATIVE approval UI end-to-end: a synthetic pending chip makes
 *    the ask visible in the transcript, `pi-agent:tool-confirm-required` turns
 *    it into an ApprovalCard (risk label/grants from shared/agent/tool-risk),
 *    and resolution rides the same `pi-agent:respond-tool` pairing as native
 *    asks — including standing-grant recording.
 *  - Fail-closed everywhere: no transport registered ⇒ "cancelled"; timeout
 *    ⇒ "cancelled" (+ expiry event so the card retires); abort ⇒ "cancelled".
 *  - The transport synthesizes the chip's completion (`status:"end"`) itself —
 *    no dsh tool runs for a plugin confirm, so nothing else would retire it.
 */

import { newId } from "../db/utils";
import { APPROVAL_TIMEOUT_MS } from "./cairn-plugins";
import { getSessionGrants } from "./approval-grants";

export interface PluginConfirmRequest {
  /** Card headline. Falls back to the tool name. */
  title?: string;
  /** Extra context shown in the arg preview block. */
  detail?: string;
  /** Tool-ish name for risk classification + standing grants ("session"). */
  toolName?: string;
  args?: Record<string, unknown>;
}

export type PluginConfirmOutcome = "allowed-once" | "rejected" | "cancelled";

export interface ConfirmTransport {
  confirm(req: PluginConfirmRequest & { signal?: AbortSignal }): Promise<PluginConfirmOutcome>;
}

// ── Session-scoped registry ──────────────────────────────────────────────────

const transports = new Map<string, ConfirmTransport>();

/** Bind (or unbind with undefined) the confirmation transport for one session. */
export function setConfirmTransport(sessionId: string, transport: ConfirmTransport | undefined): void {
  if (transport) transports.set(sessionId, transport);
  else transports.delete(sessionId);
}

export function getConfirmTransport(sessionId: string): ConfirmTransport | undefined {
  return transports.get(sessionId);
}

// ── Interactive transport (coding sessions) ──────────────────────────────────

export interface InteractiveConfirmTransportDeps {
  sessionId: string;
  /** Emit `pi-agent:*` events (already tagged with sessionId upstream). */
  send: (channel: string, payload: Record<string, unknown>) => void;
  /** Same pairing the native approval bridge uses (composite-keyed upstream). */
  registerPending: (callId: string, resolve: (decision: { approved: boolean; grant?: "session" | "command" }) => void) => () => void;
  timeoutMs?: number;
}

export function createInteractiveConfirmTransport(deps: InteractiveConfirmTransportDeps): ConfirmTransport {
  const { sessionId, send, registerPending, timeoutMs } = deps;

  const emitEnd = (callId: string, name: string, args: Record<string, unknown>, ok: boolean, output: string): void => {
    send("pi-agent:tool", { name, label: name, args, callId, status: "end", ok, output });
  };

  return {
    confirm(req) {
      // Already-dead request: never surface UI, never register anything.
      if (req.signal?.aborted) return Promise.resolve<PluginConfirmOutcome>("cancelled");
      const name = req.toolName ?? "plugin_confirm";
      const title = req.title ?? name;
      const args = { ...(req.args ?? {}), ...(req.detail ? { detail: req.detail } : {}) };
      const callId = `confirm-${newId()}`;
      const grants = getSessionGrants(sessionId);

      // Synthetic pending chip → ApprovalCard. Same channels/payload shapes as
      // cairnCodingPlugin's tool/call bridging so the renderer needs zero new
      // surfaces for a plugin ask.
      send("pi-agent:tool", { name, label: title, args, callId, status: "pending" });
      send("pi-agent:tool-confirm-required", { sessionId, name, label: title, callId });

      return new Promise<PluginConfirmOutcome>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAborts: Array<() => void> = [];
        const disposeRef: { current: () => void } = { current: () => {} };
        const settle = (outcome: PluginConfirmOutcome): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          disposeRef.current();
          for (const off of onAborts) off();
          resolve(outcome);
        };
        const finish = (approved: boolean, output: string): void => {
          emitEnd(callId, name, args, approved, output);
        };
        disposeRef.current = registerPending(callId, (decision) => {
          if (decision.approved && decision.grant === "session") grants.tools.add(name);
          finish(decision.approved, decision.approved ? "Approved." : "Denied.");
          settle(decision.approved ? "allowed-once" : "rejected");
        });
        const onAbort = () => {
          finish(false, "Cancelled while awaiting confirmation.");
          settle("cancelled");
        };
        req.signal?.addEventListener?.("abort", onAbort, { once: true });
        onAborts.push(() => req.signal?.removeEventListener?.("abort", onAbort));
        timer = setTimeout(() => {
          if (settled) return;
          send("pi-agent:tool-confirm-expired", { sessionId, name, label: title, callId });
          finish(false, "No response within the time limit — not executed.");
          settle("cancelled");
        }, timeoutMs ?? APPROVAL_TIMEOUT_MS);
      });
    },
  };
}

// ── Headless transport (automation runs) ─────────────────────────────────────

export interface HeadlessConfirmTransportDeps {
  /** Surface one ask to watchers (automation approval inbox / notifications). */
  emitApproval: (req: { callId: string; toolName: string; title?: string; detail?: string }) => void;
  /**
   * Park one ask until a human answers (durable inbox + live resolver map).
   * Timeout/fail-closed policy belongs to the inbox side (expireStaleApprovals).
   */
  registerPending: (callId: string, resolve: (approved: boolean) => void) => () => void;
}

/**
 * Headless sessions have no transcript card — plugin asks land in the SAME
 * approval inbox native tool asks use (same parking machinery, same resolver
 * IPC), so ctx.cairn.confirm works identically under automation runs.
 */
export function createHeadlessConfirmTransport(deps: HeadlessConfirmTransportDeps): ConfirmTransport {
  return {
    confirm(req) {
      const name = req.toolName ?? "plugin_confirm";
      const callId = `confirm-${newId()}`;
      deps.emitApproval({ callId, toolName: name, title: req.title, detail: req.detail });
      return new Promise<PluginConfirmOutcome>((resolve) => {
        let settled = false;
        const onAborts: Array<() => void> = [];
        let dispose: () => void = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (outcome: PluginConfirmOutcome): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          dispose();
          for (const off of onAborts) off();
          resolve(outcome);
        };
        const onAbort = () => settle("cancelled");
        if (req.signal?.aborted) onAbort();
        req.signal?.addEventListener?.("abort", onAbort, { once: true });
        onAborts.push(() => req.signal?.removeEventListener?.("abort", onAbort));
        dispose = deps.registerPending(callId, (approved) => settle(approved ? "allowed-once" : "rejected"));
        timer = setTimeout(() => settle("cancelled"), APPROVAL_TIMEOUT_MS);
      });
    },
  };
}
