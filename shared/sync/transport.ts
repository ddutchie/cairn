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
import os from "os";
import path from "path";
import type { OplogEntry } from "./engine";
import { decodeHlc } from "./hlc";
import { oplogFileName, isOplogForWorkspace, parseWorkspaceIdFromOplogName } from "./oplog-name";

// Re-export the pure filename helpers so existing importers of "./transport"
// keep working; the definitions live in the Node-free ./oplog-name module so
// the React-Native mobile transport can share them without pulling in fs/path.
export { oplogFileName, isOplogForWorkspace, parseWorkspaceIdFromOplogName };

const OPS = new Set(["put", "delete"]);

function validHlc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    decodeHlc(value);
    return true;
  } catch {
    return false;
  }
}

/** Structural guard so only well-formed entries reach applyRemote. */
function isOplogEntry(v: unknown): v is OplogEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  const observedValid = e.observed === undefined || (
    typeof e.observed === "object" &&
    e.observed !== null &&
    !Array.isArray(e.observed) &&
    Object.values(e.observed).every(validHlc)
  );
  const tombstoneValid = e.tombstone === undefined || (
    typeof e.tombstone === "object" &&
    e.tombstone !== null &&
    validHlc((e.tombstone as Record<string, unknown>).hlc) &&
    typeof (e.tombstone as Record<string, unknown>).origin === "string" &&
    decodeHlc((e.tombstone as Record<string, unknown>).hlc as string).deviceId === (e.tombstone as Record<string, unknown>).origin
  );
  return (
    validHlc(e.hlc) &&
    typeof e.origin === "string" &&
    decodeHlc(e.hlc).deviceId === e.origin &&
    typeof e.entity === "string" &&
    typeof e.entity_id === "string" &&
    typeof e.op === "string" &&
    OPS.has(e.op) &&
    (e.payload === null || (typeof e.payload === "object" && e.payload !== null)) &&
    observedValid &&
    tombstoneValid
  );
}

/** Serialise entries to the ndjson body written to disk (trailing newline when non-empty). */
function serializeOplog(entries: OplogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
}

/**
 * Write (replace) this device's oplog file, resilient to iCloud Drive on Windows.
 *
 * The old strategy — write a sibling `<target>.tmp` inside the synced folder, then
 * `rename` it over `target` — breaks under iCloud-on-Windows: iCloud tracks
 * `target` as a placeholder and often holds a handle on it, so the rename-over-
 * existing is rejected/deferred and iCloud resolves the conflict by minting a
 * numbered copy (`oplog-...-2.ndjson`, `-3`, …). It also synced the transient
 * `.tmp` file. To avoid both:
 *   • FIRST write (target absent): stage into the OS temp dir — never inside the
 *     synced folder, so iCloud never sees the tmp — then rename it in.
 *   • SUBSEQUENT writes (target present): overwrite the existing file's contents
 *     IN PLACE, so iCloud sees an in-place modification of the inode it already
 *     tracks rather than a placeholder replace. Peers already tolerate a partially
 *     synced read (parseInto skips corrupt/partial lines), so an in-place rewrite
 *     is safe here.
 *
 * NO-OP GUARD: the desktop calls this on every sync tick regardless of whether
 * the oplog changed. If the on-disk content is already byte-identical we skip
 * the write entirely — otherwise every idle tick would re-touch the file, and
 * the cloud provider would needlessly re-upload it (and peers re-download it).
 * Returns true if bytes were written, false if the write was skipped as a no-op.
 */
export function writeOplogFile(syncFolder: string, deviceId: string, entries: OplogEntry[], workspaceId?: string): boolean {
  fs.mkdirSync(syncFolder, { recursive: true });
  const target = path.join(syncFolder, oplogFileName(deviceId, workspaceId));
  const body = serializeOplog(entries);

  if (fs.existsSync(target)) {
    // Skip if nothing changed — avoids churning the synced file on idle ticks.
    try {
      if (fs.readFileSync(target, "utf-8") === body) return false;
    } catch {
      // Unreadable (e.g. dehydrated placeholder) — fall through and rewrite.
    }
    // (opt 3) Overwrite in place — do NOT rename a sibling over an iCloud placeholder.
    fs.writeFileSync(target, body, "utf-8");
    return true;
  }

  // (opt 1) First creation: stage in the OS temp dir (outside the synced folder)
  // then rename in, so iCloud never races or syncs the transient tmp file.
  const tmp = path.join(os.tmpdir(), `${oplogFileName(deviceId, workspaceId)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, body, "utf-8");
  try {
    fs.renameSync(tmp, target);
  } catch {
    // Cross-device rename (temp dir on a different volume) or iCloud rejection —
    // fall back to copy + in-place write, then clean up the staged tmp.
    fs.writeFileSync(target, body, "utf-8");
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
  return true;
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

/** Async: write (replace) this device's oplog file. iCloud-Windows-safe — see writeOplogFile.
 *  Returns true if bytes were written, false if skipped as an unchanged no-op. */
export async function writeOplogFileAsync(syncFolder: string, deviceId: string, entries: OplogEntry[], workspaceId?: string): Promise<boolean> {
  await fs.promises.mkdir(syncFolder, { recursive: true });
  const target = path.join(syncFolder, oplogFileName(deviceId, workspaceId));
  const body = serializeOplog(entries);

  let exists = true;
  try {
    await fs.promises.access(target);
  } catch {
    exists = false;
  }

  if (exists) {
    // Skip if nothing changed — avoids re-touching the synced file on idle ticks.
    try {
      if ((await fs.promises.readFile(target, "utf-8")) === body) return false;
    } catch {
      // Unreadable (e.g. dehydrated placeholder) — fall through and rewrite.
    }
    // (opt 3) In-place overwrite — avoids the iCloud placeholder-replace path.
    await fs.promises.writeFile(target, body, "utf-8");
    return true;
  }

  // (opt 1) First creation: stage outside the synced folder, then rename in.
  const tmp = path.join(os.tmpdir(), `${oplogFileName(deviceId, workspaceId)}.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.writeFile(tmp, body, "utf-8");
  try {
    await fs.promises.rename(tmp, target);
  } catch {
    // Cross-device rename or iCloud rejection — copy in place, then clean up.
    await fs.promises.writeFile(target, body, "utf-8");
    try { await fs.promises.unlink(tmp); } catch { /* best effort */ }
  }
  return true;
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
