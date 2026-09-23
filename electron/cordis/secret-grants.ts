const secretGrantsBySession = new Map<string, Set<string>>();

export function getSecretGrants(sessionId: string): Set<string> {
  let grants = secretGrantsBySession.get(sessionId);
  if (!grants) {
    grants = new Set();
    secretGrantsBySession.set(sessionId, grants);
  }
  return grants;
}

export function clearSecretGrants(sessionId: string): void {
  secretGrantsBySession.delete(sessionId);
}
