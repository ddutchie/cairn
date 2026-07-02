/**
 * Cairn Sync — synced-folder transport (Phase 0 spike)
 *
 * Decision (plan §3): each device writes an append-only per-device oplog file
 * into a cloud-synced folder (iCloud/Dropbox/Syncthing). Peers read each
 * other's files. The binary cairn.db is NEVER placed in this folder.
 *
 * File layout inside <syncFolder>:
 *   oplog-<deviceId>.ndjson   — one JSON OplogEntry per line, append-only
 *
 * Append-only + per-device means the cloud service never has to merge the same
 * file from two writers — the case file-sync handles safely.
 */

import fs from "fs";
import path from "path";
import type { OplogEntry } from "./engine";

function oplogFileName(deviceId: string): string {
  return `oplog-${deviceId}.ndjson`;
}

/** Write (replace) this device's full oplog file. Atomic via tmp+rename. */
export function writeOplogFile(syncFolder: string, deviceId: string, entries: OplogEntry[]): void {
  fs.mkdirSync(syncFolder, { recursive: true });
  const target = path.join(syncFolder, oplogFileName(deviceId));
  const tmp = `${target}.tmp`;
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  fs.writeFileSync(tmp, body, "utf-8");
  fs.renameSync(tmp, target);
}

/** Read all peer oplog entries from the folder, excluding this device's own file. */
export function readPeerOplogs(syncFolder: string, selfDeviceId: string): OplogEntry[] {
  if (!fs.existsSync(syncFolder)) return [];
  const selfFile = oplogFileName(selfDeviceId);
  const out: OplogEntry[] = [];
  for (const file of fs.readdirSync(syncFolder)) {
    if (!file.startsWith("oplog-") || !file.endsWith(".ndjson")) continue;
    if (file === selfFile) continue;
    const raw = fs.readFileSync(path.join(syncFolder, file), "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as OplogEntry);
      } catch {
        // Skip partially-synced/corrupt lines; a later sync will re-read cleanly.
      }
    }
  }
  return out;
}
