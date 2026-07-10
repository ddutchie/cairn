/**
 * Mobile sync transport over the iCloud container (react-native-cloud-store).
 *
 * MULTI-SOURCE file layout (shared with desktop):
 *   <syncFolder>/oplog-<deviceId>-<workspaceId>.ndjson  — one JSON OplogEntry
 * per line. The <workspaceId> suffix identifies the SOURCE, so many devices and
 * many workspaces share ONE folder while each reader selects only its
 * workspace's files (the privacy boundary). Async because iCloud I/O is async
 * and peer files may need downloading (iCloud stores placeholders until
 * materialized).
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

/** This device's oplog file for a given source workspace. */
function oplogFileName(deviceId: string, workspaceId: string): string {
  return `oplog-${deviceId}-${workspaceId}.ndjson`;
}

/** True if `fileName` is an oplog belonging to `workspaceId` (suffix match, not
 * a "-" split — device/workspace ids are nanoids that may contain "-"). */
function isOplogForWorkspace(fileName: string, workspaceId: string): boolean {
  return fileName.startsWith("oplog-") && fileName.endsWith(`-${workspaceId}.ndjson`);
}

/** Normalise a readDir entry (possibly a full path + iCloud placeholder) to a
 * bare filename with the ".icloud" placeholder extension stripped. */
function baseName(entryPath: string): string {
  const name = entryPath.split("/").filter(Boolean).pop() ?? "";
  return PathUtils.iCloudRemoveDotExt(name);
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

/**
 * Discover the sources (workspaces) present in the shared folder by scanning
 * oplog filenames and collecting the distinct <workspaceId> suffixes. Excludes
 * files this device itself wrote (its own writeback), so the picker shows the
 * desktop-published workspaces. Does NOT read file contents — names only.
 */
export async function listSources(folder: string, selfDeviceId: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readDir(folder);
  } catch {
    return [];
  }
  const selfPrefix = `oplog-${selfDeviceId}-`;
  const found = new Set<string>();
  for (const entryPath of entries) {
    const name = baseName(entryPath);
    if (!name.startsWith("oplog-") || !name.endsWith(".ndjson")) continue;
    if (name.startsWith(selfPrefix)) continue; // our own writeback file
    // workspaceId is the segment after the LAST "-", before ".ndjson".
    const stem = name.slice("oplog-".length, -".ndjson".length);
    const dash = stem.lastIndexOf("-");
    if (dash < 0) continue; // legacy unsuffixed file — no discoverable workspace
    const workspaceId = stem.slice(dash + 1);
    if (workspaceId) found.add(workspaceId);
  }
  return [...found].sort();
}

/** Write (replace) this device's oplog file for `workspaceId` into the folder. */
export async function writeOwnOplog(
  folder: string,
  deviceId: string,
  workspaceId: string,
  entries: OplogEntry[],
): Promise<void> {
  const path = PathUtils.join(folder, oplogFileName(deviceId, workspaceId));
  await writeFile(path, toNdjson(entries), { override: true });
}

/**
 * Read peer oplog entries for a SINGLE workspace, excluding this device's own
 * writeback file. Reading only `*-<workspaceId>.ndjson` IS the source-isolation
 * boundary: another workspace's files are never opened. Downloads iCloud
 * placeholders first so their contents are readable.
 */
export async function readSourceOplog(
  folder: string,
  workspaceId: string,
  selfDeviceId: string,
): Promise<OplogEntry[]> {
  let entries: string[] = [];
  try {
    entries = await readDir(folder);
  } catch {
    return [];
  }

  const selfFile = oplogFileName(selfDeviceId, workspaceId);
  const out: OplogEntry[] = [];
  for (const entryPath of entries) {
    const name = baseName(entryPath);
    if (!isOplogForWorkspace(name, workspaceId)) continue;
    if (name === selfFile) continue;

    const filePath = PathUtils.join(folder, name);
    try {
      // Materialise if it's still an iCloud placeholder, then read. Pass the
      // ORIGINAL entry name (may carry the ".icloud" placeholder ext) to the
      // downloader, but read from the materialised (stripped) path.
      if (!(await exist(filePath))) {
        try {
          const rawName = entryPath.split("/").filter(Boolean).pop() ?? name;
          await startDownloadingUbiquitousItem(PathUtils.join(folder, rawName));
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
