/**
 * iCloud (or any Files-provider) sync-folder access for the mobile app.
 *
 * iOS sandboxes apps: to read/write an arbitrary iCloud Drive folder we ask the
 * user to pick it once via the system directory picker. iOS grants a persistent
 * security-scoped URL for a picked directory, which we store in sync_state so
 * the app reconnects automatically on later launches.
 *
 * The chosen folder is the shared rendezvous point (plan §3): each device writes
 * its own append-only oplog file here; peers read each other's files.
 */

import { Directory } from "expo-file-system";
import { getDb } from "@/db";

const FOLDER_KEY = "sync_folder_uri";

/** Read the persisted sync-folder URI, or null if none connected yet. */
export function getSyncFolderUri(): string | null {
  const row = getDb().getFirstSync<{ value: string }>(
    "SELECT value FROM sync_state WHERE key = ?",
    FOLDER_KEY,
  );
  return row?.value ?? null;
}

function setSyncFolderUri(uri: string): void {
  getDb().runSync(
    "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    FOLDER_KEY,
    uri,
  );
}

/** Clear the connected folder (user disconnect). */
export function clearSyncFolder(): void {
  getDb().runSync("DELETE FROM sync_state WHERE key = ?", FOLDER_KEY);
}

/**
 * Prompt the user to pick the iCloud Cairn sync folder and persist it.
 * Returns the connected Directory, or null if the user cancelled.
 */
export async function connectSyncFolder(): Promise<Directory | null> {
  try {
    const dir = await Directory.pickDirectoryAsync();
    if (!dir?.uri) return null;
    setSyncFolderUri(dir.uri);
    return dir;
  } catch {
    // Picker dismissed / permission denied.
    return null;
  }
}

/** Resolve the connected folder as a Directory handle, or null if not set. */
export function getSyncFolder(): Directory | null {
  const uri = getSyncFolderUri();
  if (!uri) return null;
  return new Directory(uri);
}
