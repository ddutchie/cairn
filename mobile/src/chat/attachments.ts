/**
 * Image attachment picking for chat — wraps expo-image-picker and returns
 * data-URI attachments ready to send as multimodal "file" parts to /agent/chat.
 *
 * We request base64 so the image travels inline in the request body (the Rork
 * agent endpoint accepts data URIs); no upload/host step is needed. Images are
 * downscaled + JPEG-compressed by the picker to keep the payload reasonable.
 */

import * as ImagePicker from "expo-image-picker";
import type { Attachment } from "./agent";

function toAttachment(asset: ImagePicker.ImagePickerAsset): Attachment | null {
  if (!asset.base64) return null;
  const mediaType = asset.mimeType ?? "image/jpeg";
  return {
    mediaType,
    url: `data:${mediaType};base64,${asset.base64}`,
    name: asset.fileName ?? undefined,
  };
}

/** Launch the photo library; returns picked attachments (may be empty). */
export async function pickImages(): Promise<Attachment[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return [];
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    base64: true,
    quality: 0.6,
    allowsMultipleSelection: true,
    selectionLimit: 4,
  });
  if (res.canceled) return [];
  return res.assets.map(toAttachment).filter((a): a is Attachment => a !== null);
}

/** Launch the camera; returns a single captured attachment (or empty). */
export async function takePhoto(): Promise<Attachment[]> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return [];
  const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6 });
  if (res.canceled) return [];
  return res.assets.map(toAttachment).filter((a): a is Attachment => a !== null);
}
