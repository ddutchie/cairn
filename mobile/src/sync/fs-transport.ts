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
import { parseWorkspaceIdFromOplogName } from "@cairn/shared/sync/oplog-name";
import { isOplogEntry } from "@cairn/shared/sync/oplog-guard";

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
      const parsed = JSON.parse(t) as unknown;
      if (isOplogEntry(parsed)) out.push(parsed);
    } catch {
      // skip partial/corrupt lines
    }
  }
  return out;
}

/** A workspace discovered in the shared folder. `name` is the human workspace
 * name pulled from the oplog when available, else null (falls back in the UI). */
export interface SyncSource {
  workspaceId: string;
  name: string | null;
}

/** Materialise (if an iCloud placeholder) and read a file's text, or "" on fail. */
async function readFileMaterialised(folder: string, name: string, rawEntry: string): Promise<string> {
  const filePath = PathUtils.join(folder, name);
  try {
    if (!(await exist(filePath))) {
      try {
        const rawName = rawEntry.split("/").filter(Boolean).pop() ?? name;
        await startDownloadingUbiquitousItem(PathUtils.join(folder, rawName));
      } catch {
        /* best effort */
      }
    }
    return await readFile(filePath);
  } catch {
    return "";
  }
}

/** The workspace's own name from an oplog: the latest `put` on the `workspaces`
 * row whose id === workspaceId. Returns null if not present. */
function workspaceNameFromEntries(entries: OplogEntry[], workspaceId: string): string | null {
  let name: string | null = null;
  for (const e of entries) {
    if (e.entity !== "workspaces" || e.entity_id !== workspaceId) continue;
    if (e.op === "put" && e.payload && typeof e.payload.name === "string") {
      name = e.payload.name; // later entries win (oplog is HLC-ordered on export)
    }
  }
  return name;
}

/**
 * Discover the sources (workspaces) present in the shared folder by scanning
 * oplog filenames and collecting the distinct <workspaceId> suffixes, resolving
 * each workspace's display name from its oplog contents when available. Excludes
 * files this device itself wrote (its own writeback), so the picker shows the
 * desktop-published workspaces.
 */
export async function listSources(folder: string, selfDeviceId: string): Promise<SyncSource[]> {
  let entries: string[] = [];
  try {
    entries = await readDir(folder);
  } catch {
    return [];
  }
  const selfPrefix = `oplog-${selfDeviceId}-`;
  // workspaceId -> the raw dir entries (files) that belong to it.
  const filesByWorkspace = new Map<string, { name: string; raw: string }[]>();
  for (const entryPath of entries) {
    const name = baseName(entryPath);
    if (name.startsWith(selfPrefix)) continue; // our own writeback file
    // Derive the source workspaceId from the filename. Shared with desktop so
    // the "-" delimiter rule (deviceId has no "-", workspaceId may) stays in
    // one place; legacy unsuffixed files return null and are skipped.
    const workspaceId = parseWorkspaceIdFromOplogName(name);
    if (!workspaceId) continue;
    const list = filesByWorkspace.get(workspaceId) ?? [];
    list.push({ name, raw: entryPath });
    filesByWorkspace.set(workspaceId, list);
  }

  const out: SyncSource[] = [];
  for (const [workspaceId, files] of filesByWorkspace) {
    let name: string | null = null;
    // Read the workspace's files until we find its name (usually the first).
    for (const f of files) {
      const text = await readFileMaterialised(folder, f.name, f.raw);
      if (!text) continue;
      name = workspaceNameFromEntries(parseNdjson(text), workspaceId);
      if (name) break;
    }
    out.push({ workspaceId, name });
  }
  out.sort((a, b) => (a.name ?? a.workspaceId).localeCompare(b.name ?? b.workspaceId));
  return out;
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
