/**
 * Mobile sync transport over expo-file-system (P4).
 *
 * Mirrors the desktop synced-folder layout (shared/sync/transport.ts): each
 * device writes an append-only per-device oplog file into the shared folder:
 *
 *   <syncFolder>/oplog-<deviceId>.ndjson   — one JSON OplogEntry per line
 *
 * Because files are per-device, iCloud/Files never has to merge the same file
 * from two writers. We NEVER place the binary cairn.db in this folder.
 *
 * The desktop uses Node fs; here we use the SDK 57 File/Directory API so the
 * mobile app reads/writes the SAME file format the desktop produces/consumes.
 */

import { Directory, File } from "expo-file-system";
import type { OplogEntry } from "@cairn/shared/sync/engine";

function oplogFileName(deviceId: string): string {
  return `oplog-${deviceId}.ndjson`;
}

/** Serialize entries to NDJSON (one JSON object per line, trailing newline). */
function toNdjson(entries: OplogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
}

function parseNdjson(text: string): OplogEntry[] {
  const out: OplogEntry[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as OplogEntry);
    } catch {
      // Skip partially-synced / corrupt lines; a later read re-parses cleanly.
    }
  }
  return out;
}

/** Write (replace) this device's full oplog file into the sync folder. */
export function writeOwnOplog(folder: Directory, deviceId: string, entries: OplogEntry[]): void {
  const file = new File(folder, oplogFileName(deviceId));
  const body = toNdjson(entries);
  // File.write replaces contents. Create if missing.
  if (!file.exists) file.create();
  file.write(body);
}

/**
 * Read all peer oplog entries from the folder, excluding this device's own file.
 * Returns a flat list of entries (the engine sorts them by HLC on apply).
 */
export function readPeerOplogs(folder: Directory, selfDeviceId: string): OplogEntry[] {
  if (!folder.exists) return [];
  const selfFile = oplogFileName(selfDeviceId);
  const out: OplogEntry[] = [];
  for (const entry of folder.list()) {
    if (!(entry instanceof File)) continue;
    const name = entry.name;
    if (!name.startsWith("oplog-") || !name.endsWith(".ndjson")) continue;
    if (name === selfFile) continue;
    try {
      out.push(...parseNdjson(entry.textSync()));
    } catch {
      // Unreadable file (mid-sync); skip — next sync will retry.
    }
  }
  return out;
}
