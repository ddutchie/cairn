/**
 * Cross-remount guard for agent session prompts.
 *
 * Tracks which session ids have already fired a prompt, module-level so the
 * guard survives AgentChatPane remounts — a component ref would reset and let
 * the same session's initial prompt fire again, re-spawning a task that was
 * already started. Also powers the busy-state restore: a remount only trusts
 * the main process's live-run query once this session has fired a prompt.
 */
const firedSessionIds = new Set<string>();

export function hasPromptFired(sessionId: string): boolean {
  return firedSessionIds.has(sessionId);
}

export function markPromptFired(sessionId: string): void {
  firedSessionIds.add(sessionId);
}

/** Forget a session when it is destroyed, so its id never lingers. */
export function forgetSessionPrompts(sessionId: string): void {
  firedSessionIds.delete(sessionId);
}
