/**
 * Which sessions a Cairn window is showing right now.
 *
 * Each conversation surface (the chat panel, a coding pane, a pop-out, the
 * Today item dialog) reports its session while it's visible. Agent attention
 * uses this to tell an approval the user can already see from one waiting in a
 * chat they aren't looking at.
 *
 * Counts are kept per window (webContents id), so a window that reloads or
 * closes can be forgotten in one go without leaving a session marked as shown.
 */

const shown = new Map<number, Map<string, number>>();

/** A surface in window `windowId` started (`on`) or stopped showing `sessionId`. */
export function markSessionOnScreen(windowId: number, sessionId: string, on: boolean): void {
  if (!sessionId) return;
  let sessions = shown.get(windowId);
  if (on) {
    if (!sessions) shown.set(windowId, (sessions = new Map()));
    sessions.set(sessionId, (sessions.get(sessionId) ?? 0) + 1);
    return;
  }
  const n = sessions?.get(sessionId) ?? 0;
  if (!sessions || n <= 1) sessions?.delete(sessionId);
  else sessions.set(sessionId, n - 1);
  if (sessions && sessions.size === 0) shown.delete(windowId);
}

/** Forget everything a window reported (it reloaded or closed). */
export function forgetWindowSessions(windowId: number): void {
  shown.delete(windowId);
}

/** Is any window showing `sessionId`? */
export function isSessionOnScreen(sessionId: string): boolean {
  for (const sessions of shown.values()) if (sessions.has(sessionId)) return true;
  return false;
}

/** Test hook. */
export function _resetSessionsOnScreen(): void {
  shown.clear();
}
