/**
 * Synced attachment (image) access on mobile.
 *
 * The desktop publishes bytes as write-once, content-addressed files in the
 * shared iCloud folder (`blobs-<workspaceId>/<sha256>.<ext>`; see
 * shared/sync/attachments.ts) and the `attachments` manifest rows map an embed
 * name to a hash. The iCloud folder IS the mobile store: iCloud keeps files as
 * placeholders until requested, which gives lazy download for free, and a file
 * only appears materialised once complete (so no partial-read hazard here).
 *
 * This module only READS that store (lookup, URIs, download requests); images
 * added on the phone are written by notes/insert-image.ts.
 */

import { readDir, startDownloadingUbiquitousItem, PathUtils } from "react-native-cloud-store";
import { File } from "expo-file-system";
import { blobFileName, blobsDirName, isSha256Hex } from "@cairn/shared/sync/attachments";
import { getActiveSource, getDb } from "@/db";
import { syncFolderPathSync } from "./folder";

/** Max placeholder downloads requested per call (keeps a first sync gentle). */
const MAX_DOWNLOADS_PER_CALL = 60;

interface ManifestHit {
  hash: string;
  ext: string;
}

/** The newest live manifest row for an embed name in the active workspace. */
export function lookupAttachment(name: string): ManifestHit | null {
  const ws = getActiveSource();
  if (!ws) return null;
  try {
    const row = getDb().getFirstSync<ManifestHit>(
      `SELECT hash, ext FROM attachments
        WHERE workspace_id = ? AND name = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
      ws,
      name,
    );
    return row && isSha256Hex(row.hash) ? row : null;
  } catch {
    return null;
  }
}

function blobDirPath(workspaceId: string): string | null {
  const folder = syncFolderPathSync();
  return folder ? PathUtils.join(folder, blobsDirName(workspaceId)) : null;
}

/** file:// URI of a downloaded blob, or null when it isn't on this device (yet). */
export function blobFileUri(workspaceId: string, hash: string, ext: string): string | null {
  const dir = blobDirPath(workspaceId);
  if (!dir) return null;
  try {
    const uri = encodeURI(`file://${PathUtils.join(dir, blobFileName(hash, ext))}`);
    return new File(uri).exists ? uri : null;
  } catch {
    return null;
  }
}

/** Resolve an embed name to a displayable local URI, or null (not synced / not downloaded). */
export function resolveEmbedUri(name: string): string | null {
  const ws = getActiveSource();
  if (!ws) return null;
  const hit = lookupAttachment(name);
  return hit ? blobFileUri(ws, hit.hash, hit.ext) : null;
}

/**
 * Ask iCloud to download any blob of a live manifest row that is still a
 * placeholder. Fire-and-forget: downloads complete in the background and the
 * image component notices the file appearing. Best effort, never throws.
 */
export async function requestMissingBlobs(workspaceId: string): Promise<number> {
  const dir = blobDirPath(workspaceId);
  if (!dir) return 0;
  let entries: string[];
  try {
    entries = await readDir(dir);
  } catch {
    return 0; // desktop hasn't published any images yet
  }
  let wanted: Set<string>;
  try {
    const rows = getDb().getAllSync<ManifestHit>(
      "SELECT hash, ext FROM attachments WHERE workspace_id = ? AND deleted_at IS NULL",
      workspaceId,
    );
    wanted = new Set(rows.filter((r) => isSha256Hex(r.hash)).map((r) => `${r.hash}.${r.ext}`));
  } catch {
    return 0;
  }
  let started = 0;
  for (const entry of entries) {
    if (started >= MAX_DOWNLOADS_PER_CALL) break;
    const raw = entry.split("/").filter(Boolean).pop() ?? "";
    const base = PathUtils.iCloudRemoveDotExt(raw);
    if (base === raw || !wanted.has(base)) continue; // already materialised, or not ours
    try {
      await startDownloadingUbiquitousItem(PathUtils.join(dir, raw));
      started++;
    } catch {
      /* best effort */
    }
  }
  return started;
}
