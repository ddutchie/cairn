/**
 * Local-first persistence layer.
 * Thin wrapper around localStorage with JSON serialization.
 * Designed so the read/write interface can be swapped out for
 * an IndexedDB or remote Supabase adapter later without changing callers.
 */

const STORAGE_VERSION = "v1";
const PREFIX = `cairn:${STORAGE_VERSION}:`;

export const storage = {
  get<T>(key: string): T | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  set<T>(key: string, value: T): void {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (e) {
      console.error("[cairn:storage] write error", e);
    }
  },

  delete(key: string): void {
    if (typeof window === "undefined") return;
    localStorage.removeItem(PREFIX + key);
  },

  clear(): void {
    if (typeof window === "undefined") return;
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX));
    keys.forEach((k) => localStorage.removeItem(k));
  },
};
