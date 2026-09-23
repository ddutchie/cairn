const controllers = new Map<string, AbortController>();
const running = new Set<string>();

export function startTurn(sessionId: string): AbortController {
  controllers.get(sessionId)?.abort();
  const controller = new AbortController();
  controllers.set(sessionId, controller);
  running.add(sessionId);
  return controller;
}

export function endTurn(sessionId: string, controller?: AbortController): void {
  if (!controller || controllers.get(sessionId) === controller) controllers.delete(sessionId);
  running.delete(sessionId);
}

export function abortTurn(sessionId: string): void {
  controllers.get(sessionId)?.abort();
  controllers.delete(sessionId);
  running.delete(sessionId);
}

export function isTurnRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

export function getRunningTurnIds(): string[] {
  return Array.from(running);
}
