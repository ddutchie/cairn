/**
 * Desktop attachment sync (images/PDFs embedded in notes).
 *
 * Two channels, both driven from `syncDesktop` (desktop-sync.ts):
 *
 *   1. registerAttachments — scan notes for `![[name.png]]` / `asset://name.png`
 *      embeds, hash the local file and insert an `attachments` manifest row. The
 *      row is a normal syncable table, so it rides the oplog to peers. The first
 *      scan walks every note (this IS the backfill for pre-existing images);
 *      later scans only look at notes edited since the previous scan.
 *   2. publishBlobs / fetchBlobs — copy bytes between the workspace attachment
 *      folder and `<syncFolder>/blobs-<workspaceId>/<sha256>.<ext>`. Content
 *      addressed + write-once, so no two devices ever write the same file with
 *      different bytes, and iCloud/Dropbox never has to merge anything.
 *
 * Attachment problems must never fail the oplog sync: callers wrap these in
 * try/catch, and every per-file failure here is skipped and retried next tick.
 * The user's own files are never deleted or overwritten.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import type Database from "better-sqlite3";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentId,
  blobFileName,
  blobsDirName,
  collisionName,
  extOf,
  extractEmbedNames,
  isSha256Hex,
  isSyncableAttachmentName,
} from "../../shared/sync/attachments";
import { findAttachmentFile, resolveAttachmentDir } from "../host-shared/attachment-dir";

const SCAN_KEY = "attachments_scan_at";
/** local path → "size:mtime:hash" of files already verified equal to their manifest row. */
const verifiedLocal = new Map<string, string>();
/** Cap blob copies per tick so a huge first sync can't monopolise the main loop. */
const MAX_COPIES_PER_TICK = 200;

export interface AttachmentSyncResult {
  /** Manifest rows newly registered this tick. */
  registered: number;
  /** Blobs copied into the sync folder. */
  published: number;
  /** Blobs copied from the sync folder into the workspace. */
  fetched: number;
  /** Manifest rows whose bytes are not available yet (will retry). */
  pending: number;
  /** Incoming files saved under a hash-suffixed name because the name was taken. */
  collisions: number;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function getState(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * Write bytes to `target` without ever exposing a half-written file to a cloud
 * provider. The temp file lives in the TARGET's directory so the rename is
 * atomic on every volume (a temp dir on another volume would force a direct
 * write, which iCloud/Dropbox can upload mid-write — and blobs are write-once,
 * so a partial upload would stay stuck). Leading dot + `.tmp` keeps it out of
 * the way of readers, which only look for `<sha256>.<ext>` names.
 */
async function writeFileStaged(target: string, buf: Buffer): Promise<void> {
  const dir = path.dirname(target);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.cairn-att-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  await fs.promises.writeFile(tmp, buf);
  try {
    await fs.promises.rename(tmp, target);
  } catch (err) {
    try { await fs.promises.unlink(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Register every embedded attachment of the source workspace in the manifest.
 * Returns the number of NEW rows. Safe to call every tick.
 */
export async function registerAttachments(
  db: Database.Database,
  workspacePath: string,
  workspaceId: string,
): Promise<number> {
  if (!workspaceId) return 0;
  const startedAt = new Date().toISOString();
  const since = getState(db, SCAN_KEY);
  const likeEmbeds = "(content LIKE '%![[%' OR content LIKE '%asset://%')";
  const rows = (
    since
      ? db.prepare(`SELECT content FROM notes WHERE deleted_at IS NULL AND ${likeEmbeds} AND updated_at >= ?`).all(since)
      : db.prepare(`SELECT content FROM notes WHERE deleted_at IS NULL AND ${likeEmbeds}`).all()
  ) as Array<{ content: string | null }>;

  const names = new Set<string>();
  for (const r of rows) for (const n of extractEmbedNames(r.content)) names.add(n);

  const find = db.prepare("SELECT deleted_at FROM attachments WHERE id = ?");
  const insert = db.prepare(
    `INSERT INTO attachments (id, workspace_id, hash, name, ext, size, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const revive = db.prepare("UPDATE attachments SET deleted_at = NULL, updated_at = ? WHERE id = ?");

  let registered = 0;
  for (const name of names) {
    const file = findAttachmentFile(workspacePath, name);
    if (!file) continue; // not on this device (yet) — a peer's manifest row may supply it
    try {
      const stat = await fs.promises.stat(file);
      if (stat.size > MAX_ATTACHMENT_BYTES) continue;
      const hash = sha256(await fs.promises.readFile(file));
      const id = attachmentId(hash, name);
      const existing = find.get(id) as { deleted_at: string | null } | undefined;
      const now = new Date().toISOString();
      if (!existing) {
        insert.run(id, workspaceId, hash, name, extOf(name), stat.size, now, now);
        registered++;
      } else if (existing.deleted_at) {
        revive.run(now, id);
        registered++;
      }
    } catch {
      /* unreadable right now — retried when the note is next edited / on next full scan */
    }
  }
  setState(db, SCAN_KEY, startedAt);
  return registered;
}

interface ManifestRow {
  hash: string;
  name: string;
  ext: string;
  size: number;
}

function liveManifest(db: Database.Database, workspaceId: string): ManifestRow[] {
  const rows = db
    .prepare("SELECT hash, name, ext, size FROM attachments WHERE workspace_id = ? AND deleted_at IS NULL")
    .all(workspaceId) as ManifestRow[];
  // A synced row is untrusted input: only well-formed hash/name/ext may reach the filesystem.
  return rows.filter(
    (r) => isSha256Hex(r.hash) && isSyncableAttachmentName(r.name) && r.name === path.basename(r.name) && extOf(r.name) === r.ext,
  );
}

/** Copy local attachments that the sync folder doesn't hold yet. */
export async function publishBlobs(
  db: Database.Database,
  syncFolder: string,
  workspacePath: string,
  workspaceId: string,
): Promise<{ published: number; pending: number }> {
  if (!workspaceId) return { published: 0, pending: 0 };
  const blobDir = path.join(syncFolder, blobsDirName(workspaceId));
  const have = new Set<string>(await fs.promises.readdir(blobDir).catch(() => [] as string[]));
  let published = 0;
  let pending = 0;
  for (const row of liveManifest(db, workspaceId)) {
    const blob = blobFileName(row.hash, row.ext);
    if (have.has(blob)) continue;
    const local = findAttachmentFile(workspacePath, row.name);
    if (!local) { pending++; continue; } // bytes live on another device
    if (published >= MAX_COPIES_PER_TICK) { pending++; continue; }
    try {
      const buf = await fs.promises.readFile(local);
      if (sha256(buf) !== row.hash) continue; // file was edited after registration; a newer row covers it
      await writeFileStaged(path.join(blobDir, blob), buf);
      published++;
    } catch {
      pending++;
    }
  }
  return { published, pending };
}

/** Copy blobs the sync folder holds into the workspace for manifest rows we lack bytes for. */
export async function fetchBlobs(
  db: Database.Database,
  syncFolder: string,
  workspacePath: string,
  workspaceId: string,
): Promise<{ fetched: number; pending: number; collisions: number }> {
  if (!workspaceId) return { fetched: 0, pending: 0, collisions: 0 };
  const blobDir = path.join(syncFolder, blobsDirName(workspaceId));
  const have = new Set<string>(await fs.promises.readdir(blobDir).catch(() => [] as string[]));
  const destDir = resolveAttachmentDir(workspacePath);
  let fetched = 0;
  let pending = 0;
  let collisions = 0;
  for (const row of liveManifest(db, workspaceId)) {
    const local = findAttachmentFile(workspacePath, row.name);
    let targetName = row.name;
    if (local) {
      // Size is only a fast NEGATIVE check — equal sizes are common (fixed-size
      // screenshots), so a match still needs the hash. Verified files are
      // remembered by (size, mtime) so an idle tick doesn't re-read every image.
      try {
        const st = await fs.promises.stat(local);
        if (st.size === row.size) {
          const stamp = `${st.size}:${st.mtimeMs}:${row.hash}`;
          if (verifiedLocal.get(local) === stamp) continue;
          if (sha256(await fs.promises.readFile(local)) === row.hash) {
            verifiedLocal.set(local, stamp);
            continue;
          }
        } else if (sha256(await fs.promises.readFile(local)) === row.hash) {
          continue; // identical bytes under a stale manifest size
        }
      } catch {
        continue;
      }
      // The name is taken by different bytes → keep both, never overwrite the user's file.
      targetName = collisionName(row.name, row.hash);
      if (fs.existsSync(path.join(destDir, targetName))) continue;
    }
    const blob = blobFileName(row.hash, row.ext);
    if (!have.has(blob)) { pending++; continue; }
    if (fetched >= MAX_COPIES_PER_TICK) { pending++; continue; }
    try {
      const buf = await fs.promises.readFile(path.join(blobDir, blob));
      // A cloud provider can expose a file before it is fully downloaded: never install a short read.
      if (sha256(buf) !== row.hash) { pending++; continue; }
      await writeFileStaged(path.join(destDir, targetName), buf);
      fetched++;
      if (targetName !== row.name) collisions++;
    } catch {
      pending++;
    }
  }
  return { fetched, pending, collisions };
}

/** Full attachment pass for one sync tick. Never throws. */
export async function syncAttachments(
  db: Database.Database,
  syncFolder: string,
  workspacePath: string,
  workspaceId: string,
): Promise<AttachmentSyncResult> {
  const out: AttachmentSyncResult = { registered: 0, published: 0, fetched: 0, pending: 0, collisions: 0 };
  try {
    const pub = await publishBlobs(db, syncFolder, workspacePath, workspaceId);
    const fet = await fetchBlobs(db, syncFolder, workspacePath, workspaceId);
    out.published = pub.published;
    out.fetched = fet.fetched;
    out.collisions = fet.collisions;
    out.pending = pub.pending + fet.pending;
  } catch (err) {
    console.error("[sync] attachment blob pass failed:", err);
  }
  return out;
}
