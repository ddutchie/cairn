/**
 * Staged attachments → what the model sees. Images are admitted (type, size and
 * count limits) and travel inline with the prompt; PDFs are not readable yet, so
 * the model is told one was attached instead of silently losing it.
 */
import type { UserImage } from "./events";

export interface Attachment { kind?: "image" | "pdf"; dataUrl: string; name?: string }

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 20;
/** Images ride inline in the session log, so the per-message total is kept well under engine's old 200 MiB. */
export const MAX_MESSAGE_IMAGE_BYTES = 48 * 1024 * 1024;

function parseDataUrl(url: string): { mediaType: string; base64: string; bytes: number } | undefined {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!m || !m[2]) return undefined;
  const base64 = m[3];
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return { mediaType: m[1].toLowerCase(), base64, bytes: Math.floor((base64.length * 3) / 4) - padding };
}

export function prepareAttachments(text: string, attachments: readonly Attachment[] | undefined): { text: string; images: UserImage[] } {
  const images: UserImage[] = [];
  let out = text;
  let total = 0;
  for (const att of attachments ?? []) {
    const parsed = parseDataUrl(att.dataUrl);
    if (!parsed) continue;
    if (att.kind === "pdf" || parsed.mediaType === "application/pdf") {
      out += `\n\n[A PDF${att.name ? ` "${att.name}"` : ""} was attached, but PDF attachments are not yet supported. Ask the user to paste the relevant text if you need its contents.]`;
      continue;
    }
    if (!IMAGE_MEDIA_TYPES.includes(parsed.mediaType)) continue;
    if (parsed.bytes > MAX_IMAGE_BYTES || images.length >= MAX_IMAGES_PER_MESSAGE || total + parsed.bytes > MAX_MESSAGE_IMAGE_BYTES) continue;
    total += parsed.bytes;
    images.push({ mediaType: parsed.mediaType, data: parsed.base64, ...(att.name ? { name: att.name } : {}) });
  }
  return { text: out, images };
}
