"use client";

/**
 * Shared file→dataUrl attachment reader used by both the chat and agent inputs,
 * so image/PDF handling can never drift between the two surfaces.
 *
 * Images become `image` items; PDFs become `pdf` items when the model is
 * pdf-capable, otherwise their pages are rasterized to images (when the model
 * is image-capable). Anything the model can't consume is skipped.
 */

import { rasterizePdfToImages } from "@/lib/pdf-rasterize";
import { MAX_ATTACHMENT_BYTES } from "../../shared/models/pdf-attach";

export interface AttachmentItem {
  kind: "image" | "pdf";
  name: string;
  dataUrl: string;
}

export async function readAttachments(
  files: File[],
  opts: { allowImages: boolean; allowPdf: boolean },
): Promise<AttachmentItem[]> {
  const items: AttachmentItem[] = [];
  for (const file of files) {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const isImage = file.type.startsWith("image/");
    if (!isPdf && !isImage) continue;
    if (isPdf && !opts.allowPdf && !opts.allowImages) continue;
    if (isImage && !opts.allowImages) continue;
    // Reject oversized files BEFORE reading them into memory — a multi-GB file
    // would otherwise blow up the renderer. The main process enforces the same
    // cap on the IPC boundary.
    if (file.size > MAX_ATTACHMENT_BYTES) {
      console.warn(`[attachments] Skipping "${file.name}" — ${file.size} bytes exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB attachment limit`);
      continue;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
        reader.onabort = () => reject(new Error(`Read aborted for ${file.name}`));
        reader.readAsDataURL(file);
      });
      if (isPdf && opts.allowPdf) {
        items.push({ kind: "pdf", name: file.name, dataUrl });
      } else if (isImage && opts.allowImages) {
        items.push({ kind: "image", name: file.name, dataUrl });
      } else if (isPdf) {
        // Not pdf-capable, but image-capable → rasterize pages as images.
        try {
          const pages = await rasterizePdfToImages(dataUrl);
          pages.forEach((page, p) =>
            items.push({ kind: "image", name: `${file.name} — page ${p + 1}`, dataUrl: page }));
        } catch (err) {
          console.error(`[attachments] PDF rasterization failed for ${file.name}:`, err);
        }
      }
    } catch (err) {
      console.error("[attachments] Skipping unreadable attachment:", err);
    }
  }
  return items;
}
