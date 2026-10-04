import type { Context } from "@deepseek-ai/cordis";
import "../ctx-augment";
import { createHostStore, newId, type HostStore } from "../host-store";
import { getSessionGrants, canonicalBashCommand, recordPendingApprovalArgs, readPendingApprovalArgs, forgetPendingApprovalArgs } from "../approval-grants";
import { getSecretGrants } from "../secret-grants";
import { riskForTool as riskForToolShared, isShellTool } from "../../../shared/agent/tool-risk";
import type { RiskClass } from "../../../shared/agent/tool-risk";
import { shouldAskForTool, modeFromAutoApprove, isMode, type Mode } from "../../../shared/agent/approval-mode";
import { getHost } from "./db";
import { secretPathForCall, sendProjection } from "./shared";

// ── cairn-approval ────────────────────────────────────────────────────────────
// Human-in-the-loop tool approval for the coding agent (Phase 1.5 step 2e).
// When autoApprove is OFF, mutating tools must be confirmed by the user before
// they run. dsh's approval seam (ctx.approval) + tools pipeline provide the
// mechanism: a `tools/pre-execute` handler returns {kind:'ask'} for a mutating
// tool, the pipeline calls ctx.approval.request, and this plugin's answerer
// bridges that to Cairn's renderer confirm UI (session:tool-confirm-required ⇄
// session:respond-tool). Read-only tools always pass (never ask).

export interface CairnApprovalConfig {
  /** When true, every tool runs without a confirm prompt (no asks) — legacy alias for mode:"auto". */
  autoApprove?: boolean;
  /** OpenWorker-style approval Mode. When set it takes precedence over autoApprove. */
  mode?: Mode;
  /** The caller's sessionId — scopes the confirm IPC. */
  sessionId: string;
  /** Emit a `session:*` IPC event (sessionId NOT yet tagged). */
  send: (channel: string, payload: Record<string, unknown>) => void;
  /**
   * Register a resolver for one pending approval, keyed by callId; returns a
   * disposer. The session:respond-tool IPC handler invokes the resolver with
   * the user's decision.
   */
  registerPending: (callId: string, resolve: (decision: { approved: boolean; grant?: "session" | "command" | "workspace" }) => void) => () => void;
  signal?: AbortSignal;
  /** Fail-closed idle timeout for one ask. Defaults to APPROVAL_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Workspace-persistent "Always allow" grants. When a workspaceId is supplied,
   * a grant stored via `grant:"workspace"` (persisted by session:respond-tool)
   * auto-allows the same tool (and, for bash, the same exact command) in every
   * future session of that workspace — not just this one. Mirrors automation
   * standing rules (target-aware, exec refuses wildcard). When absent (coding
   * sessions without a workspace context, tests), only the in-memory session
   * grants are consulted.
   */
  workspaceId?: string;
  /**
   * DB handle for persistent-grant lookups. Required when workspaceId is set.
   * @deprecated — prefer `host` (the HostStore seam); kept so older callers
   * and unit harnesses pass unchanged. When both are present, `host` wins.
   */
  db?: import("better-sqlite3").Database;
  /**
   * Injected HostStore for persistent-grant lookups. Falls back to wrapping
   * `db`, then to the store mounted by `cairnDbPlugin` (`CAIRN_HOST`).
   */
  host?: HostStore;
  /**
   * When set, only tools whose risk class is in the set gate through the
   * approval seam — everything else is implicitly allowed. Chat uses this to
   * auto-allow Cairn DB writes (WRITE_LOCAL) while still gating EXTERNAL
   * (MCP/service) and EXEC (bash/subagent).
   */
  askRiskClasses?: ReadonlySet<RiskClass>;
  /**
   * Additional predicate: when it returns true the tool is gated even if its
   * risk class is not in askRiskClasses. Chat uses this to gate deletions
   * (which are WRITE_LOCAL) while still auto-allowing creates/updates.
   */
  askFilter?: (name: string, args: Record<string, unknown>) => boolean;
  /**
   * What decides when a tool call asks:
   *   - "mode" (default): Cairn's risk taxonomy × approval Mode — every
   *     mutating tool asks unless the mode is "auto". Automations rely on this.
   *   - "sandbox": dsh parity. No per-tool gate at all — the sandbox (the
   *     session's permission preset) is the guard, and only what dsh itself
   *     routes through the approval seam asks: sandbox escalations and hooks,
   *     under the preset's approval policy. Cairn data tools always run. The
   *     protected secret-file guard is kept.
   */
  gate?: "mode" | "sandbox";
}

/**
 * Fail-closed idle timeout for interactive HITL prompts. Without it an ask
 * whose card was lost to a renderer reload blocks the loop forever (audit G6);
 * the automation inbox had the same 10-minute fail-closed budget before the
 * Cordis cutover.
 */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/**
 * Bridge dsh's approval seam to Cairn's renderer confirm UI. Mounted per turn.
 * No-op when autoApprove is true. Otherwise:
 *   1. tools/pre-execute → {kind:'ask'} for any non-safe tool (mutating) whose
 *      tool name / exact bash command hasn't been granted for the session.
 *   2. approval/request answerer → emit session:tool-confirm-required, block on
 *      session:respond-tool, map to allowed-once / rejected.
 * Grants (grant:'session' for a tool, grant:'command' for an exact bash
 * command) live in the per-session approval-grants store so they survive this
 * turn — this mount is disposed with it.
 */
export function cairnApprovalPlugin(ctx: Context, config: CairnApprovalConfig): (() => void) | void {
  const { sessionId, send, registerPending, signal, timeoutMs, workspaceId, db, askRiskClasses, askFilter } = config;
  // HostStore seam: explicit host wins, then wrap the legacy db handle, then
  // the per-turn store mounted by cairnDbPlugin. Same underlying db either way.
  const host = config.host ?? (db ? createHostStore(db) : getHost(ctx));
  const effectiveMode: Mode = config.mode && isMode(config.mode)
    ? config.mode
    : modeFromAutoApprove(config.autoApprove);
  // No early-return for "auto": EXTERNAL still asks (OpenWorker taxonomy).
  // READ never asks in any mode — handled by shouldAskForTool.

  /** True when the tool's risk class is in the ask set, or when no filter is set (ask for everything mutating). */
  const riskGates = (name: string, argsObj: Record<string, unknown>): boolean => {
    if (askFilter?.(name, argsObj)) return true;
    if (!askRiskClasses) return true;
    return askRiskClasses.has(riskForToolShared(name));
  };

  const disposers: Array<() => void> = [];
  // Per-session grants (survive this turn) + workspace-persistent grants.
  const grants = getSessionGrants(sessionId);
  const isGranted = (name: string, argsObj: Record<string, unknown>): boolean => {
    if (grants.tools.has(name)) return true;
    if (isShellTool(name)) {
      const cmd = canonicalBashCommand(argsObj.command);
      if (cmd && grants.bashCommands.has(cmd)) return true;
    }
    // Workspace-persistent grants (mirrors automation standing rules, but
    // scoped to a workspace rather than to one automation; target-aware,
    // exec refuses wildcard). Consulted here so an "Always allow" survives
    // across sessions — not just the session:respond-tool fallback.
    if (workspaceId && host) {
      try {
        if (host.isWorkspaceGranted(workspaceId, name)) return true;
        if (isShellTool(name)) {
          const cmd = canonicalBashCommand(argsObj.command);
          if (cmd && host.isWorkspaceGranted(workspaceId, name, cmd)) return true;
        }
      } catch { /* DB not yet migrated or closed — fall through to no grant */ }
    }
    return false;
  };

  // 1) Ask-trigger: mutating tools route to the approval seam.
  // ctx.on('tools/pre-execute', ...) — the waterfall event dsh-tools drives.
  // The generic arg is untyped in the augmentation for third-party events;
  // cast the handler's args narrowly to keep the touch site typed.
  const unsubPre = (ctx.on as unknown as (ev: string, fn: (...args: unknown[]) => unknown) => () => void)(
    "tools/pre-execute",
    (...args: unknown[]) => {
      const exec = args[0] as { name?: string; arguments?: unknown; callId?: string } | undefined;
      const next = args[1] as (() => Promise<unknown>) | undefined;
      const name = exec?.name;
      const argsObj = (exec?.arguments && typeof exec.arguments === "object") ? exec.arguments as Record<string, unknown> : {};
      // Secret-file gate — runs before the risk gate so even "read" (otherwise safe)
      // still asks. Default is deny; Allow once / Allow for session (grant:session)
      // adds the file path to the per-session secret allowlist.
      if (typeof name === "string") {
        const secretPath = secretPathForCall(name, argsObj);
        if (secretPath) {
          const granted = getSecretGrants(sessionId).has(secretPath);
          if (!granted) {
            if (exec?.callId) recordPendingApprovalArgs(sessionId, exec.callId, { ...argsObj, __secretPath: secretPath });
            return Promise.resolve({ kind: "ask", reason: `"${name}" targets a protected secret file and needs your approval.` });
          }
        }
      }
      if (typeof name === "string" && config.gate !== "sandbox" && shouldAskForTool(name, effectiveMode, argsObj) && riskGates(name, argsObj) && !isGranted(name, argsObj)) {
        // Stash the TRUSTED args so session:respond-tool can record a
        // grant:'command' against what dsh will actually execute — not
        // whatever string a compromised renderer echoes back. dsh's
        // ApprovalRequest deliberately carries no arguments (upstream
        // decision), so this main-side side-channel is the only way to keep
        // the grant target bound to the executed call.
        if (exec?.callId) recordPendingApprovalArgs(sessionId, exec.callId, argsObj);
        return Promise.resolve({ kind: "ask", reason: `"${name}" needs your approval before it runs.` });
      }
      return next ? next() : undefined;
    },
  );
  disposers.push(unsubPre);

  // 2) Answerer: bridge the ask to the renderer confirm UI.
  const unsubAns = (ctx.on as unknown as (ev: string, fn: (...args: unknown[]) => unknown) => () => void)(
    "approval/request",
    (...args: unknown[]) => {
      const req = args[0] as { toolName?: string; callId?: string; reason?: string; signal?: AbortSignal } | undefined;
      const toolName = req?.toolName ?? "tool";
      const callId = req?.callId ?? `approve-${newId()}`;
      // dsh-sandbox routes a sandbox_permissions escalation through this same
      // seam, for the same callId, after the tool gate already settled. A tool
      // grant ("Allow for session" / "Always allow" on pwsh) must never widen
      // the sandbox silently, so escalations always ask and carry their reason.
      const escalation = typeof req?.reason === "string" && req.reason.startsWith("escalate sandbox to ");
      // Protected-file requests must be authorized by the exact secret path, not by a generic tool grant.
      const pendingSecret = readPendingApprovalArgs(sessionId, callId)?.__secretPath as string | undefined;
      if (escalation) {
        // fall through to the interactive ask
      } else if (pendingSecret) {
        if (getSecretGrants(sessionId).has(pendingSecret)) return Promise.resolve("allowed-once");
      } else {
        if (grants.tools.has(toolName)) return Promise.resolve("allowed-once");
        // Workspace-persistent grants also short-circuit the ask without emitting
        // a card, so an "Always allow" covers future sessions silently.
        if (workspaceId && host) {
          try {
            if (host.isWorkspaceGranted(workspaceId, toolName)) return Promise.resolve("allowed-once");
          } catch { /* DB not migrated — fall through to ask */ }
        }
      }
       sendProjection(send, sessionId, "approval", { status: "required", name: toolName, label: toolName, callId, ...(escalation ? { reason: req!.reason } : {}) });
      return new Promise<string>((resolve) => {
        // Single-settle guard: exactly one of respond / abort / timeout wins,
        // and the abort listeners never linger after a normal settle.
        //
        // Synchronous-resolve safety: some transports (heartbeat-runner
        // auto-allow at :605-611, or a future optimistic-allow) call the
        // provided `resolve()` inside their `registerPending(callId, cb)`
        // call — before registerPending has returned its dispose function.
        // Two symptoms of naive code here:
        //   (a) `const dispose = registerPending(...)`: the callback runs
        //       during the initializer, hits `settle()` → `dispose()` and
        //       throws `ReferenceError: Cannot access 'dispose' before
        //       initialization` (TDZ). dsh catches → unavailable → deny.
        //   (b) A ref indirection alone (`disposeRef.current = registerPending`)
        //       has `disposeRef.current` still null when the synchronous
        //       callback runs, so dispose is never invoked and any registry
        //       entry leaks.
        // Fix: also buffer the outcome in `syncOutcome`. If the callback runs
        // synchronously, settle() early-returns and stashes it; after
        // registerPending returns we assign disposeRef.current and, if a sync
        // outcome was captured, replay settle() to run dispose + resolve.
        let settled = false;
        // eslint-disable-next-line prefer-const -- reassigned at end of block; declaration must precede settle() to avoid TDZ during sync replay.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAborts: Array<() => void> = [];
        const disposeRef: { current: (() => void) | null } = { current: null };
        let syncOutcome: "allowed-once" | "rejected" | "cancelled" | null = null;
        const settle = (outcome: "allowed-once" | "rejected" | "cancelled") => {
          if (settled) return;
          // Synchronous callback path: disposeRef.current isn't set yet.
          // Buffer the outcome; the initializer-tail replay below will run
          // this again with disposeRef.current populated.
          if (disposeRef.current === null && syncOutcome === null) {
            syncOutcome = outcome;
            return;
          }
          settled = true;
          clearTimeout(timer);
          disposeRef.current?.();
          for (const off of onAborts) off();
          // Drop the trusted args stash for this callId — the ask settled.
          forgetPendingApprovalArgs(sessionId, callId);
          resolve(outcome);
        };
        disposeRef.current = registerPending(callId, (d) => {
          // An escalation answer is one-shot: never let it mint a standing grant.
          const decision = escalation ? { approved: d.approved } as typeof d : d;
          if (decision.approved && decision.grant === "session") {
            grants.tools.add(toolName);
            // Secret-file session grant — allow that exact secret path for the rest of the session
            const trusted = readPendingApprovalArgs(sessionId, callId) as Record<string, unknown> | undefined;
            const secretPath = trusted?.__secretPath as string | undefined;
            if (secretPath) getSecretGrants(sessionId).add(secretPath);
          }
          // grant:"command" is recorded by the session:respond-tool handler,
          // which owns the canonicalized command text (dsh's ApprovalRequest
          // deliberately carries no args). grant:"workspace" persists to the
          // workspace DB so future sessions auto-allow (the same handler also
          // persists it — this in-plugin path covers the headless/auto-allow
          // transports that settle without going through the IPC handler).
          if (decision.approved && decision.grant === "workspace" && workspaceId && host) {
            try {
              const trusted = readPendingApprovalArgs(sessionId, callId);
              // For bash/pwsh the workspace grant is command-scoped (like
              // grant:command); for everything else it is tool-scoped (target = null).
              const commandScoped = isShellTool(toolName);
              const target = commandScoped && trusted ? canonicalBashCommand(trusted.command) : null;
              host.addWorkspaceApprovalGrant(workspaceId, toolName, target);
              // Also grant this session immediately so the current turn proceeds
              // without waiting for the DB read to take effect on the next ask.
              // A command-scoped grant covers that command only, never the whole shell.
              if (commandScoped) {
                if (target) grants.bashCommands.add(target);
              } else {
                grants.tools.add(toolName);
              }
            } catch { /* DB not migrated or closed — session grant already applied */ }
          }
          settle(decision.approved ? "allowed-once" : "rejected");
        });
        // Replay a buffered sync outcome now that disposeRef is populated.
        if (syncOutcome !== null && !settled) {
          const captured = syncOutcome;
          syncOutcome = null;
          settle(captured);
        }
        const onAbort = () => settle("cancelled");
        if (req?.signal?.aborted || signal?.aborted) onAbort();
        for (const sig of [req?.signal, signal]) {
          if (!sig) continue;
          sig.addEventListener?.("abort", onAbort, { once: true });
          onAborts.push(() => sig.removeEventListener?.("abort", onAbort));
        }
        timer = setTimeout(() => {
          if (settled) return;
           sendProjection(send, sessionId, "approval", { status: "expired", name: toolName, label: toolName, callId });
          settle("cancelled");
        }, timeoutMs ?? APPROVAL_TIMEOUT_MS);
      });
    },
  );
  disposers.push(unsubAns);

  return () => { for (const d of disposers) { try { d(); } catch { /* noop */ } } };
}
