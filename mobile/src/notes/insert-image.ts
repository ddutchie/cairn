/**
 * Add an image to a note from the phone: photo library, camera, or clipboard.
 *
 * Pipeline (every source ends up the same):
 *   1. normalise — downscale (longest side ≤ 2000px) and re-encode (JPEG, or PNG
 *      for PNG sources such as screenshots) so a 48MP/HEIC photo becomes a small,
 *      desktop-renderable file well under the 10MB sync cap;
 *   2. hash the bytes (sha256) and name it `photo-<hash8>.<ext>` — content-derived,
 *      so two devices can never collide and re-adding the same image is a no-op;
 *   3. publish the blob into the iCloud sync folder (`blobs-<ws>/<hash>.<ext>`),
 *      the same content-addressed store the desktop reads (shared/sync/attachments.ts);
 *   4. insert an `attachments` manifest row — a plain INSERT, so the capture
 *      triggers stage it for the next sync;
 *   5. return `![[name]]` for the caller to splice into the note body.
 *
 * An image only syncs because a note embeds it: nothing is published until step 3,
 * which only runs for an image the user chose to add to a note.
 */

import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as Clipboard from "expo-clipboard";
import * as ExpoCrypto from "expo-crypto";
import { File } from "expo-file-system";
import { createDir, exist, upload, PathUtils } from "react-native-cloud-store";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentId,
  blobFileName,
  blobsDirName,
} from "@cairn/shared/sync/attachments";
import { getActiveSource, getDb } from "@/db";
import { notifyLocalWrite } from "@/sync/write-signal";
import { syncFolderPathSync } from "@/sync/folder";
import { isDemoSource } from "@/dev/demo-seed";

/** Longest edge after downscaling. Plenty for a phone/desktop note, small on disk. */
const MAX_EDGE = 2000;
const JPEG_QUALITY = 0.85;

export type ImageSource = "library" | "camera" | "clipboard";

export class InsertImageError extends Error {}

interface RawImage {
  uri: string;
  width: number;
  height: number;
  /** True when the source is a PNG (kept lossless — screenshots, diagrams). */
  png: boolean;
}

async function fromLibrary(): Promise<RawImage | null> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: false,
    quality: 1,
  });
  if (res.canceled || !res.assets[0]) return null;
  const a = res.assets[0];
  return { uri: a.uri, width: a.width, height: a.height, png: /png/i.test(a.mimeType ?? a.uri) };
}

async function fromCamera(): Promise<RawImage | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new InsertImageError("Camera access is off. Enable it for Cairn in Settings.");
  const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
  if (res.canceled || !res.assets[0]) return null;
  const a = res.assets[0];
  return { uri: a.uri, width: a.width, height: a.height, png: false };
}

async function fromClipboard(): Promise<RawImage | null> {
  const img = await Clipboard.getImageAsync({ format: "png" });
  if (!img) throw new InsertImageError("There's no image on the clipboard.");
  return { uri: img.data, width: img.size.width, height: img.size.height, png: true };
}

/** Whether the clipboard currently holds an image (drives the "Paste" option). */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    return await Clipboard.hasImageAsync();
  } catch {
    return false;
  }
}

async function normalise(raw: RawImage): Promise<{ uri: string; ext: "jpg" | "png" }> {
  const longest = Math.max(raw.width, raw.height);
  const actions: ImageManipulator.Action[] = [];
  if (longest > MAX_EDGE) {
    actions.push({ resize: raw.width >= raw.height ? { width: MAX_EDGE } : { height: MAX_EDGE } });
  }
  const format = raw.png ? ImageManipulator.SaveFormat.PNG : ImageManipulator.SaveFormat.JPEG;
  const out = await ImageManipulator.manipulateAsync(raw.uri, actions, { format, compress: JPEG_QUALITY });
  return { uri: out.uri, ext: raw.png ? "png" : "jpg" };
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Add an image to the active workspace's synced attachments and return the
 * `![[name]]` embed to insert, or null when the user cancelled the picker.
 * Throws InsertImageError with a user-presentable message on failure.
 */
export async function addImageFromSource(source: ImageSource): Promise<string | null> {
  const workspaceId = getActiveSource();
  const folder = syncFolderPathSync();
  if (!workspaceId) throw new InsertImageError("Pick a workspace before adding images.");
  // Images publish straight to iCloud; the sample workspace never leaves the phone.
  if (isDemoSource(workspaceId)) throw new InsertImageError("Images can't be added to the sample workspace.");
  if (!folder) throw new InsertImageError("Images sync through iCloud. Sign in to iCloud to add images.");

  const raw =
    source === "library" ? await fromLibrary() : source === "camera" ? await fromCamera() : await fromClipboard();
  if (!raw) return null;

  const { uri, ext } = await normalise(raw);
  const bytes = await new File(uri).arrayBuffer();
  if (bytes.byteLength === 0) throw new InsertImageError("That image couldn't be read.");
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new InsertImageError("That image is too large (max 10MB).");

  const hash = toHex(await ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, bytes));
  const name = `photo-${hash.slice(0, 8)}.${ext}`;

  // Publish the bytes (content-addressed: skip when already there).
  const blobDir = PathUtils.join(folder, blobsDirName(workspaceId));
  const blobPath = PathUtils.join(blobDir, blobFileName(hash, ext));
  try {
    if (!(await exist(blobDir))) await createDir(blobDir);
  } catch {
    /* createDir throws when it already exists in some cases */
  }
  try {
    if (!(await exist(blobPath))) await upload(uri.replace(/^file:\/\//, ""), blobPath);
  } catch (e) {
    throw new InsertImageError(`Couldn't save the image to iCloud${e instanceof Error ? `: ${e.message}` : "."}`);
  }

  // Register in the synced manifest (INSERT OR IGNORE: re-adding the same image is a no-op).
  const now = new Date().toISOString();
  getDb().runSync(
    `INSERT OR IGNORE INTO attachments (id, workspace_id, hash, name, ext, size, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    attachmentId(hash, name),
    workspaceId,
    hash,
    name,
    ext,
    bytes.byteLength,
    now,
    now,
  );
  notifyLocalWrite();
  return `![[${name}]]`;
}
