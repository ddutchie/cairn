/** Neutral persisted identity for a resumable Cordis session. */
export type SessionProfileId = "chat" | "coding" | "automation-dev";

export function isSessionProfileId(value: unknown): value is SessionProfileId {
  return value === "chat" || value === "coding" || value === "automation-dev";
}

export function selectSessionProfile(
  persisted: SessionProfileId | null | undefined,
  requested: unknown,
): { profile?: SessionProfileId; error?: string } {
  if (persisted && requested !== undefined && persisted !== requested) {
    return { error: `Session profile is ${persisted}; it cannot be changed to ${String(requested)}.` };
  }
  if (persisted) return { profile: persisted };
  if (isSessionProfileId(requested)) return { profile: requested };
  return { error: "A profile is required when creating a session." };
}
