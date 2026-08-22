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
