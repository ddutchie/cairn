/**
 * Cairn Sync — synced-folder transport (Phase 0 spike)
 *
 * Decision (plan §3): each device writes an append-only per-device oplog file
 * into a cloud-synced folder (iCloud/Dropbox/Syncthing). Peers read each
 * other's files. The binary cairn.db is NEVER placed in this folder.
 *
 * File layout inside <syncFolder>:
 *   oplog-<deviceId>-<workspaceId>.ndjson  — one JSON OplogEntry per line,
 *                                            append-only. The <workspaceId>
 *                                            suffix identifies the SOURCE, so
 *                                            many devices and many workspaces
 *                                            can share one folder while each
 *                                            reader selects only its workspace.
 *   (legacy: oplog-<deviceId>.ndjson       — no suffix; whole-DB, still read.)
 *
 * Append-only + per-device means the cloud service never has to merge the same
 * file from two writers — the case file-sync handles safely.
 */

import fs from "fs";
import path from "path";
import type { OplogEntry } from "./engine";

/**
 * Reject ids that could escape the sync folder or corrupt the filename.
 * Ids are minted locally (device: "desktop_ab12cd34…"; workspace: a nanoid,
 * whose alphabet includes "-" and "_"), so we allow those but reject path
 * separators, traversal tokens, and dots-only names. "-" is permitted inside a
 * segment because workspace nanoids can contain it — the filename is matched by
 * the FULL known workspaceId as a suffix (isOplogForWorkspace), never by
 * splitting on "-", so a "-" in an id can't misroute the match.
 */
function assertSafeId(id: string, kind: "deviceId" | "workspaceId"): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`Unsafe sync ${kind}: ${JSON.stringify(id)}`);
  }
}

/**
 * Oplog filename. When `workspaceId` is given, the source (= workspace) is
 * encoded as a suffix: `oplog-<deviceId>-<workspaceId>.ndjson`. This lets many
 * devices AND many workspaces share one sync folder while each reader selects
 * only the files for its workspace (the privacy boundary). Omitting
 * `workspaceId` yields the legacy `oplog-<deviceId>.ndjson` name.
 */
function oplogFileName(deviceId: string, workspaceId?: string): string {
  assertSafeId(deviceId, "deviceId");
  if (workspaceId == null || workspaceId === "") return `oplog-${deviceId}.ndjson`;
  assertSafeId(workspaceId, "workspaceId");
  return `oplog-${deviceId}-${workspaceId}.ndjson`;
}

/**
 * True if `fileName` is an oplog file belonging to `workspaceId`. Matched by
 * the FULL known workspaceId as a suffix rather than splitting on "-" (both
 * device and workspace ids are nanoids that may contain "-"), so a "-" in an
 * id can't misroute the match. Device ids are `desktop_…`/`mobile_…` (no "-"),
 * so `-<workspaceId>.ndjson` unambiguously identifies the workspace segment.
 */
function isOplogForWorkspace(fileName: string, workspaceId: string): boolean {
  return fileName.startsWith("oplog-") && fileName.endsWith(`-${workspaceId}.ndjson`);
}

const OPS = new Set(["put", "delete"]);

/** Structural guard so only well-formed entries reach applyRemote. */
function isOplogEntry(v: unknown): v is OplogEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.hlc === "string" &&
    typeof e.origin === "string" &&
    typeof e.entity === "string" &&
    typeof e.entity_id === "string" &&
    typeof e.op === "string" &&
    OPS.has(e.op) &&
    (e.payload === null || (typeof e.payload === "object" && e.payload !== null))
  );
}

/** Write (replace) this device's full oplog file. Atomic via tmp+rename. */
export function writeOplogFile(syncFolder: string, deviceId: string, entries: OplogEntry[], workspaceId?: string): void {
  fs.mkdirSync(syncFolder, { recursive: true });
  const target = path.join(syncFolder, oplogFileName(deviceId, workspaceId));
  const tmp = `${target}.tmp`;
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  fs.writeFileSync(tmp, body, "utf-8");
  fs.renameSync(tmp, target);
}

/**
 * Read peer oplog entries from the folder, excluding this device's own file.
 * When `workspaceId` is given, reads ONLY files for that workspace
 * (`oplog-*-<workspaceId>.ndjson`) — this is the source-isolation boundary in a
 * shared folder. Omitting it reads every `oplog-*.ndjson` (legacy whole-DB).
 */
export function readPeerOplogs(syncFolder: string, selfDeviceId: string, workspaceId?: string): OplogEntry[] {
  if (!fs.existsSync(syncFolder)) return [];
  const selfFile = oplogFileName(selfDeviceId, workspaceId);
  const out: OplogEntry[] = [];
  for (const file of fs.readdirSync(syncFolder)) {
    if (workspaceId ? !isOplogForWorkspace(file, workspaceId) : !(file.startsWith("oplog-") && file.endsWith(".ndjson"))) continue;
    if (file === selfFile) continue;
    const raw = fs.readFileSync(path.join(syncFolder, file), "utf-8");
    for (const line of raw.split("\n")) parseInto(out, line);
  }
  return out;
}

/** Push one parsed+validated entry from a raw line into `out` (shared by sync/async). */
function parseInto(out: OplogEntry[], line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    if (isOplogEntry(parsed)) out.push(parsed);
    // else: shape mismatch (partial/older/corrupt) — skip like bad JSON.
  } catch {
    // Skip partially-synced/corrupt lines; a later sync will re-read cleanly.
  }
}

// ── Async variants (preferred on the Electron main process) ─────────────────
// The desktop drives sync on timers against a possibly network-backed folder
// (iCloud/Dropbox), so it uses these fs.promises versions to avoid blocking the
// main loop on slow I/O. The sync versions above remain for tests and any
// caller that is already off the hot path.

/** Async: write (replace) this device's full oplog file. Atomic via tmp+rename. */
export async function writeOplogFileAsync(syncFolder: string, deviceId: string, entries: OplogEntry[], workspaceId?: string): Promise<void> {
  await fs.promises.mkdir(syncFolder, { recursive: true });
  const target = path.join(syncFolder, oplogFileName(deviceId, workspaceId));
  const tmp = `${target}.tmp`;
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  await fs.promises.writeFile(tmp, body, "utf-8");
  await fs.promises.rename(tmp, target);
}

/**
 * Async: read peer oplog entries, excluding this device's own file. When
 * `workspaceId` is given, reads ONLY that workspace's files (source isolation).
 */
export async function readPeerOplogsAsync(syncFolder: string, selfDeviceId: string, workspaceId?: string): Promise<OplogEntry[]> {
  try {
    await fs.promises.access(syncFolder);
  } catch {
    return [];
  }
  const selfFile = oplogFileName(selfDeviceId, workspaceId);
  const out: OplogEntry[] = [];
  const files = await fs.promises.readdir(syncFolder);
  for (const file of files) {
    if (workspaceId ? !isOplogForWorkspace(file, workspaceId) : !(file.startsWith("oplog-") && file.endsWith(".ndjson"))) continue;
    if (file === selfFile) continue;
    const raw = await fs.promises.readFile(path.join(syncFolder, file), "utf-8");
    for (const line of raw.split("\n")) parseInto(out, line);
  }
  return out;
}
