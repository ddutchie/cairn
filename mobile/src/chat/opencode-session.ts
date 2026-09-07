/**
 * Stable per-conversation session id for the OpenCode Zen proxy.
 *
 * The proxy expects `x-opencode-session` (stable for the lifetime of a
 * conversation) for routing + prompt caching. Mobile has a single chat
 * thread at a time, so one persisted id covers the active conversation;
 * it is rotated when the user clears chat history.
 *
 * Stored in the device-global meta table (same DB as AI config), not in
 * SecureStore — it's not a secret, just an opaque routing token.
 */

import * as Crypto from "expo-crypto";
import { getMeta, setMeta } from "@/db";

const KEY = "opencode.sessionId";

function newId(): string {
  try {
    // expo-crypto is the only reliable UUID source on device.
    const u = (Crypto as unknown as { randomUUID?: () => string }).randomUUID?.();
    if (u) return u;
  } catch {
    // fall through
  }
  // Fallback for tests / bare JS where expo-crypto is mocked.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getOpencodeSessionId(): string {
  const existing = getMeta(KEY);
  if (existing) return existing;
  const id = newId();
  try {
    setMeta(KEY, id);
  } catch {
    // best-effort
  }
  return id;
}

export function resetOpencodeSessionId(): string {
  const id = newId();
  try {
    setMeta(KEY, id);
  } catch {
    // ignore
  }
  return id;
}

export function clearOpencodeSessionId(): void {
  try {
    setMeta(KEY, "");
  } catch {
    // ignore
  }
}
