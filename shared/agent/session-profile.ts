/** Neutral persisted identity for a resumable Cordis session. */
export type SessionProfileId = "chat" | "coding" | "automation-dev";

export function isSessionProfileId(value: unknown): value is SessionProfileId {
  return value === "chat" || value === "coding" || value === "automation-dev";
}
