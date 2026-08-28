/** Profiles supported by the shared session-bound popout surface. */
import { isSessionProfileId, type SessionProfileId } from "./session-profile";

export type SessionPopoutProfile = SessionProfileId;

/** Identity-only contract shared by the Electron handoff and popout route. */
export interface ChatPopoutPayload {
  sessionId: string;
  activeProjectId: string | null;
  profile: SessionPopoutProfile;
  workspaceId: string | null;
  cwd: string | null;
}

export interface StoredSessionPopoutMetadata {
  profile: SessionPopoutProfile;
  workspaceId: string | null;
  projectId: string | null;
  cwd: string | null;
}

/** Select recipients without coupling session routing tests to Electron windows. */
export function chatParticipantIdsExcept(participants: ReadonlySet<number>, excludeId?: number): number[] {
  return Array.from(participants).filter((id) => id !== excludeId);
}

export function bindChatPopoutSession(value: unknown): ChatPopoutPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<ChatPopoutPayload>;
  if (typeof payload.sessionId !== "string" || payload.sessionId.length === 0) return null;
  if (payload.activeProjectId !== null && typeof payload.activeProjectId !== "string") return null;
  if (!isSessionProfileId(payload.profile)) return null;
  if (payload.workspaceId !== null && typeof payload.workspaceId !== "string") return null;
  if (payload.cwd !== null && typeof payload.cwd !== "string") return null;
  return {
    sessionId: payload.sessionId,
    activeProjectId: payload.activeProjectId ?? null,
    profile: payload.profile,
    workspaceId: payload.workspaceId ?? null,
    cwd: payload.cwd ?? null,
  };
}

/** Prefer durable session metadata, while retaining handoff values for old sessions. */
export function resolveChatPopoutSession(
  payload: ChatPopoutPayload,
  stored: StoredSessionPopoutMetadata | null,
): ChatPopoutPayload | null {
  if (stored && stored.profile !== payload.profile) return null;
  if (!stored) return payload;
  return {
    ...payload,
    profile: stored.profile,
    activeProjectId: stored.projectId ?? payload.activeProjectId,
    workspaceId: stored.workspaceId ?? payload.workspaceId,
    cwd: stored.cwd ?? payload.cwd,
  };
}

/** Transport strategy only; both profiles use the same session-bound pane. */
export function sessionPopoutCommand(_profile: SessionPopoutProfile): "session:prompt" {
  return "session:prompt";
}
