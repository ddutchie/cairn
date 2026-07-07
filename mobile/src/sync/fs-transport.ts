/**
 * Mobile sync transport over the iCloud container (react-native-cloud-store).
 *
 * Same file layout as desktop: <syncFolder>/oplog-<deviceId>.ndjson, one JSON
 * OplogEntry per line. Async because iCloud I/O is async and peer files may
 * need downloading (iCloud stores placeholders until materialized).
 */

import {
  writeFile,
  readFile,
  readDir,
  exist,
  startDownloadingUbiquitousItem,
  PathUtils,
} from "react-native-cloud-store";
import type { OplogEntry } from "@cairn/shared/sync/engine";

function oplogFileName(deviceId: string): string {
  return `oplog-${deviceId}.ndjson`;
}

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
      // skip partial/corrupt lines
    }
  }
  return out;
}

/** Write (replace) this device's oplog file into the sync folder. */
export async function writeOwnOplog(folder: string, deviceId: string, entries: OplogEntry[]): Promise<void> {
  const path = PathUtils.join(folder, oplogFileName(deviceId));
  await writeFile(path, toNdjson(entries), { override: true });
}

/**
 * Read all peer oplog entries from the folder, excluding this device's file.
 * Downloads iCloud placeholders first so their contents are readable.
 */
export async function readPeerOplogs(folder: string, selfDeviceId: string): Promise<OplogEntry[]> {
  const selfFile = oplogFileName(selfDeviceId);
  let entries: string[] = [];
  try {
    entries = await readDir(folder);
  } catch {
    return [];
  }

  const out: OplogEntry[] = [];
  for (const entryPath of entries) {
    // readDir returns full-ish paths; normalise to a basename.
    const name = entryPath.split("/").filter(Boolean).pop() ?? "";
    // iCloud placeholders are named "<file>.icloud" — strip for the match.
    const realName = PathUtils.iCloudRemoveDotExt(name);
    if (!realName.startsWith("oplog-") || !realName.endsWith(".ndjson")) continue;
    if (realName === selfFile) continue;

    const filePath = PathUtils.join(folder, realName);
    try {
      // Materialise if it's still an iCloud placeholder, then read.
      if (!(await exist(filePath))) {
        try {
          await startDownloadingUbiquitousItem(PathUtils.join(folder, name));
        } catch {
          /* best effort */
        }
      }
      const text = await readFile(filePath);
      out.push(...parseNdjson(text));
    } catch {
      // Unreadable / still downloading; next sync retries.
    }
  }
  return out;
}
