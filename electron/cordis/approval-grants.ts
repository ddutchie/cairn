/**
 * Per-session approval grants that OUTLIVE a single turn.
 *
 * The interactive approval bridge (cairnApprovalPlugin) is mounted per turn and
 * disposed with it — any grant state held there would silently expire after
 * every prompt while the UI promises "always". This module owns the durable
 * per-session state instead:
 *
 *   - tools        — tool names granted via "Always allow this tool"
 *                    (pi-agent:respond-tool grant:"session")
 *   - bashCommands — canonicalized bash commands granted via "Always allow this
 *                    command" (grant:"command"). Exact-string matching only:
 *                    no prefixes, no wildcards (same stance as automation
 *                    standing rules, which refuse wildcard exec grants).
 *
 * Grants are cleared with their session (pi-agent:clear / :destroy).
 */

export interface SessionGrants {
  /** Tool names exempt from future approval asks in this session. */
  tools: Set<string>;
  /** Canonicalized bash commands exempt from future asks in this session. */
  bashCommands: Set<string>;
}

const sessionGrants = new Map<string, SessionGrants>();

/** Get (creating on first use) the grant store for one coding session. */
export function getSessionGrants(sessionId: string): SessionGrants {
  let g = sessionGrants.get(sessionId);
  if (!g) {
    g = { tools: new Set(), bashCommands: new Set() };
    sessionGrants.set(sessionId, g);
  }
  return g;
}

/** Drop all grants for a session (called on pi-agent:clear / :destroy). */
export function clearSessionGrants(sessionId: string): void {
  sessionGrants.delete(sessionId);
}

/**
 * Canonicalize a bash command for standing-grant storage/matching: trim and
 * collapse internal whitespace runs so cosmetic reformatting of the identical
 * command still matches. Returns null for empty input.
 */
export function canonicalBashCommand(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const canonical = command.trim().replace(/\s+/g, " ");
  return canonical.length > 0 ? canonical : null;
}

// ── Trusted per-callId argument store ────────────────────────────────────────
//
// The pi-agent:respond-tool IPC handler needs to know the EXECUTED command
// text (not the renderer's echo of what it thinks was asked) so a
// grant:'command' click grants exactly what dsh will run — not whatever
// string a compromised renderer or UI plugin can inject via the IPC. dsh's
// ApprovalRequest deliberately carries no arguments (see
// dsh-user-approval/src/index.ts:147), so we stash them at
// tools/pre-execute time (main-side, trusted) keyed by `${sessionId}::${callId}`
// and retrieve them when the approve response arrives.
//
// Cleared per-callId when the ask settles (approve / deny / expire / abort).

const pendingApprovalArgs = new Map<string, Record<string, unknown>>();

function argsKey(sessionId: string, callId: string): string {
  return `${sessionId}::${callId}`;
}

/** Record the trusted args for a pending approval ask. */
export function recordPendingApprovalArgs(
  sessionId: string,
  callId: string,
  args: Record<string, unknown>,
): void {
  pendingApprovalArgs.set(argsKey(sessionId, callId), args);
}

/** Read the trusted args for a callId (returns undefined if never recorded). */
export function readPendingApprovalArgs(
  sessionId: string,
  callId: string,
): Record<string, unknown> | undefined {
  return pendingApprovalArgs.get(argsKey(sessionId, callId));
}

/** Drop the trusted args for a callId (settled). */
export function forgetPendingApprovalArgs(sessionId: string, callId: string): void {
  pendingApprovalArgs.delete(argsKey(sessionId, callId));
}

/** Drop every pending arg entry for a session (session cleared / closed). */
export function forgetSessionApprovalArgs(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const k of Array.from(pendingApprovalArgs.keys())) {
    if (k.startsWith(prefix)) pendingApprovalArgs.delete(k);
  }
}

// ── Pending-ask registry ─────────────────────────────────────────────────────

/** One outstanding HITL prompt, enough to re-surface it after a renderer reload. */
export interface PendingAskMeta {
  sessionId: string;
  name: string;
  label: string;
  callId: string;
  /**
   * Per-ask random nonce minted when the ask was emitted. The renderer must
   * echo it back on pi-agent:respond-tool — a compromised page / UI plugin
   * that only saw the callId can't approve because it never received the
   * nonce. Absent on legacy sites; the verify path fail-closes when the
   * expected nonce is missing.
   */
  nonce?: string;
}

export interface PendingAskRegistry {
  record(meta: PendingAskMeta): void;
  /** Remove one ask (answered / aborted / expired). */
  resolve(sessionId: string, callId: string): void;
  listForSession(sessionId: string): PendingAskMeta[];
  clearSession(sessionId: string): void;
}

/**
 * Tracks outstanding tool-approval asks so a reloading renderer can pull them
 * (`pi-agent:is-running`) instead of relying on the original push — which the
 * reload swallowed while the main-process promise stayed blocked.
 */
export function createPendingAskRegistry(): PendingAskRegistry {
  const byKey = new Map<string, PendingAskMeta>();
  const key = (sessionId: string, callId: string): string => `${sessionId}::${callId}`;
  return {
    record: (meta) => { byKey.set(key(meta.sessionId, meta.callId), meta); },
    resolve: (sessionId, callId) => { byKey.delete(key(sessionId, callId)); },
    listForSession: (sessionId) => {
      const prefix = `${sessionId}::`;
      return Array.from(byKey.entries()).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
    clearSession: (sessionId) => {
      const prefix = `${sessionId}::`;
      for (const k of Array.from(byKey.keys())) if (k.startsWith(prefix)) byKey.delete(k);
    },
  };
}
