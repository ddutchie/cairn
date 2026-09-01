import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import type { Attachment } from "./agent";

/**
 * Convert a local file uri (file://, ph://, content://) to a data-URI Attachment.
 * Reads via FileSystem as base64. For ph:// assets (photo grid), we resolve via
 * MediaLibrary.getAssetInfoAsync to get a file:// uri first.
 */
async function uriToAttachment(uri: string, fallbackName?: string, fallbackMime?: string): Promise<Attachment | null> {
  let fileUri = uri;
  let name = fallbackName;
  let mime = fallbackMime ?? "image/jpeg";

  // ph:// — resolve via MediaLibrary
  if (uri.startsWith("ph://")) {
    try {
      const assetId = uri;
      // expo-media-library Query ids are already ph://, but getAssetInfoAsync wants the id without ph:// prefix on some SDKs.
      // Try both.
      let info: unknown = null;
      try {
        info = await MediaLibrary.getAssetInfoAsync(assetId);
      } catch {
        info = await MediaLibrary.getAssetInfoAsync(assetId.replace("ph://", ""));
      }
      const localUri = (info as { localUri?: string })?.localUri;
      const uri2 = (info as { uri?: string })?.uri;
      if (localUri) fileUri = localUri;
      else if (uri2) fileUri = uri2;
      else return null;
      if ((info as { filename?: string })?.filename) name = (info as { filename: string }).filename;
    } catch {
      return null;
    }
  }

  try {
    const base64 = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
    // Infer mime from extension if not provided
    if (!fallbackMime && name) {
      const ext = name.split(".").pop()?.toLowerCase();
      if (ext === "png") mime = "image/png";
      else if (ext === "heic" || ext === "heif") mime = "image/heic";
      else if (ext === "webp") mime = "image/webp";
      else if (ext === "pdf") mime = "application/pdf";
      else if (ext === "txt" || ext === "md") mime = "text/plain";
    }
    return { mediaType: mime, url: `data:${mime};base64,${base64}`, name };
  } catch {
    return null;
  }
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export async function pickFiles(): Promise<Attachment[]> {
  const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (res.canceled) return [];
  const out: Attachment[] = [];
  for (const asset of res.assets) {
    if (typeof asset.size === "number" && asset.size > MAX_ATTACHMENT_BYTES) continue;
    const mime = asset.mimeType ?? "application/octet-stream";
    try {
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      out.push({ mediaType: mime, url: `data:${mime};base64,${base64}`, name: asset.name });
    } catch {
      // Fallback: treat as file uri attachment without base64 (some providers accept uri)
      out.push({ mediaType: mime, url: asset.uri, name: asset.name });
    }
    if (out.length >= 8) break;
  }
  return out;
}

export async function libraryPhotoToAttachment(phId: string): Promise<Attachment | null> {
  const att = await uriToAttachment(phId);
  if (att) return att;
  // Fallback: use ph:// directly for immediate preview; will be readable by expo-image
  // The agent can still receive it as a file URI if base64 fails (provider will handle)
  return { mediaType: "image/jpeg", url: phId, name: phId.split("/").pop() };
}

export async function cameraUriToAttachment(fileUri: string): Promise<Attachment | null> {
  return uriToAttachment(fileUri, `photo-${Date.now()}.jpg`, "image/jpeg");
}
