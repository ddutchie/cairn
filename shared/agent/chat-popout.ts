/** Profiles supported by the shared session-bound popout surface. */
import { isSessionProfileId, type SessionProfileId } from "./session-profile";

export type SessionPopoutProfile = SessionProfileId;

/** Identity-only contract shared by the Electron handoff and popout route. */
export interface ChatPopoutPayload {
  sessionId: string;
  activeProjectId: string | null;
  profile: SessionPopoutProfile;
}

export function bindChatPopoutSession(value: unknown): ChatPopoutPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<ChatPopoutPayload>;
  if (typeof payload.sessionId !== "string" || payload.sessionId.length === 0) return null;
  if (payload.activeProjectId !== null && typeof payload.activeProjectId !== "string") return null;
  if (!isSessionProfileId(payload.profile)) return null;
  return { sessionId: payload.sessionId, activeProjectId: payload.activeProjectId ?? null, profile: payload.profile };
}

/** Transport strategy only; both profiles use the same session-bound pane. */
export function sessionPopoutCommand(_profile: SessionPopoutProfile): "session:prompt" {
  return "session:prompt";
}
