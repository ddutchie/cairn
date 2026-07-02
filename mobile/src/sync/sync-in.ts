/**
 * Mobile sync-in (P3, read-only direction: desktop -> mobile).
 *
 * The synced folder holds append-only per-device oplog files
 * (oplog-<deviceId>.ndjson). On mobile we cannot enumerate an iCloud folder as
 * freely as on desktop, so for the read-only MVP the user picks the desktop's
 * oplog file(s) via the document picker; we read the NDJSON and feed it to the
 * shared SyncEngine, which reconciles it into the local DB.
 *
 * The reconcile logic is the EXACT same shared/sync engine the desktop runs, so
 * convergence guarantees proven in P0 hold here too.
 *
 * P4 will add: bidirectional sync, writing this device's oplog back out, and a
 * more automatic folder-watch story.
 */

import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import type { OplogEntry } from "@shared/sync/engine";
import { getEngine } from "@/db";

function parseNdjson(text: string): OplogEntry[] {
  const out: OplogEntry[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as OplogEntry);
    } catch {
      // skip partial / corrupt lines; a later import re-reads cleanly
    }
  }
  return out;
}

export interface SyncInResult {
  filesImported: number;
  opsApplied: number;
  conflictCopies: number;
}

/**
 * Let the user pick one or more desktop oplog .ndjson files and reconcile them
 * into the local DB. Returns a summary for the UI.
 */
export async function importOplogFiles(): Promise<SyncInResult> {
  const picked = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
    // NDJSON has no standard UTI; accept everything and filter by name.
    type: "*/*",
  });

  if (picked.canceled) return { filesImported: 0, opsApplied: 0, conflictCopies: 0 };

  const engine = getEngine();
  let opsApplied = 0;
  let conflictCopies = 0;
  let filesImported = 0;

  for (const asset of picked.assets) {
    if (!asset.name.endsWith(".ndjson")) continue;
    const text = await FileSystem.readAsStringAsync(asset.uri);
    const entries = parseNdjson(text);
    if (entries.length === 0) continue;
    const res = engine.applyRemote(entries);
    opsApplied += entries.length;
    conflictCopies += res.conflictCopies.length;
    filesImported += 1;
  }

  return { filesImported, opsApplied, conflictCopies };
}
