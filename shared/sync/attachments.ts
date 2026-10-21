/**
 * Cairn Sync — attachment (image) helpers shared by desktop and mobile.
 *
 * Attachments sync on two channels:
 *   1. MANIFEST — a tiny `attachments` row per (content hash, embed name) rides the
 *      normal oplog, so peers learn "![[photo.png]] means blob <sha256>".
 *   2. BLOBS — the bytes live as write-once, content-addressed files in the sync
 *      folder: <syncFolder>/blobs-<workspaceId>/<sha256>.<ext>. Never in the oplog.
 *
 * Pure string helpers only (no Node/fs) so the React-Native bundle can import it.
 */

import { assertSafeId } from "./oplog-name";

/** Extensions that sync as attachments. Mirrors `app:uploadAsset`'s allow-list. */
export const ATTACHMENT_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "pdf"] as const;
const ATTACHMENT_EXT_SET: ReadonlySet<string> = new Set(ATTACHMENT_EXTS);

/** Max bytes per synced attachment (matches the 10MB upload cap). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Row shape of the synced `attachments` table. */
export interface AttachmentRow {
  id: string;
  workspace_id: string;
  hash: string;
  name: string;
  ext: string;
  size: number;
}

const HASH_RE = /^[0-9a-f]{64}$/;
export function isSha256Hex(v: unknown): v is string {
  return typeof v === "string" && HASH_RE.test(v);
}

/** Lowercase extension without the dot ("" when none). */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function isSyncableAttachmentName(name: string): boolean {
  return ATTACHMENT_EXT_SET.has(extOf(name));
}

/** Stable manifest row id: one row per (bytes, embed name). */
export function attachmentId(hash: string, name: string): string {
  return `${hash}:${name}`;
}

/** Blob directory inside the sync folder for one workspace (source isolation). */
export function blobsDirName(workspaceId: string): string {
  assertSafeId(workspaceId, "workspaceId");
  return `blobs-${workspaceId}`;
}

/** Blob filename — content-addressed, so concurrent writers never conflict. */
export function blobFileName(hash: string, ext: string): string {
  if (!isSha256Hex(hash)) throw new Error(`Invalid attachment hash: ${JSON.stringify(hash)}`);
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error(`Invalid attachment ext: ${JSON.stringify(ext)}`);
  return `${hash}.${ext}`;
}

/**
 * Embed targets referenced by a note body: `![[name.png]]`, `![[name.png|300]]`,
 * `![[name.png#x]]` and legacy `asset://name.png`. Returns unique bare filenames
 * (no folders, no alias/width) whose extension is syncable. Folder-qualified
 * targets (`![[sub/x.png]]`) keep only the basename — desktop resolves by name.
 */
export function extractEmbedNames(content: string | null | undefined): string[] {
  if (!content) return [];
  const out = new Set<string>();
  const add = (raw: string) => {
    let target = raw.split("|")[0].split("#")[0].trim();
    const slash = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
    if (slash >= 0) target = target.slice(slash + 1);
    if (target && isSyncableAttachmentName(target)) out.add(target);
  };
  const embed = /!\[\[((?:(?!\[\[)[^\n])+?)\]\](?!\])/g;
  let m: RegExpExecArray | null;
  while ((m = embed.exec(content)) !== null) add(m[1]);
  const legacy = /asset:\/\/([^\s)"'<>]+)/g;
  while ((m = legacy.exec(content)) !== null) {
    try {
      add(decodeURIComponent(m[1]));
    } catch {
      add(m[1]);
    }
  }
  return [...out];
}

/** Name for a colliding incoming blob: `photo.png` + hash → `photo-3fa9c1d2.png`. */
export function collisionName(name: string, hash: string): string {
  const ext = extOf(name);
  const base = ext ? name.slice(0, -(ext.length + 1)) : name;
  return `${base}-${hash.slice(0, 8)}${ext ? `.${ext}` : ""}`;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  pdf: "application/pdf",
};
export function mimeForExt(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "application/octet-stream";
}
