/**
 * cairn-attachment-store — user-message content-block builder for the
 * Cordis engine.
 *
 * Historically this file also housed CairnAttachmentStore, a 294-line
 * hand-rolled AttachmentStore that parsed PNG/JPEG/WebP/GIF headers directly
 * because dsh-attachment only shipped the ABSTRACT AttachmentStore. As of
 * this branch, upstream ships @deepseek-ai/dsh-attachment-local (the
 * persistent content-addressed store backed by sharp with proper image
 * normalization + compression limiting) at the same pinned version, so
 * the hand-rolled backend was retired — see run-cordis-loop.ts, which now
 * mounts LocalAttachmentStore under the "cairn:attachment-store" plugin
 * name (kept for backwards compatibility of the ENTRY_LIST id).
 *
 * What remains here is the ONE piece that's genuinely Cairn business
 * logic: mapping Cairn's `ChatRequest.images` (a mix of image data URLs
 * and PDFs) into dsh's user-message ContentBlock[] shape. Images route
 * through the mounted store via `ctx.get("attachments")`; PDFs are a
 * text-degraded passthrough for v1 (dsh's ContentBlock union has no
 * document block, and pdfjs would bloat the Electron main bundle).
 */
import type { Context } from "@deepseek-ai/cordis";
import type AttachmentStore from "@deepseek-ai/dsh-attachment";
import type { ImageAttachmentRef, ImageMediaType } from "@deepseek-ai/dsh-attachment";

/** Attachment on an outgoing message (Cairn's ChatRequest.images shape). */
export interface MessageAttachment {
  kind?: "image" | "pdf";
  /** base64 data URL, e.g. data:image/png;base64,… */
  dataUrl: string;
  name?: string;
}

/** A dsh content block (text or image). Kept loose to avoid a hard type import. */
type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; attachment: ImageAttachmentRef };

const DATA_URL_RE = /^data:([^;,]+)(;base64)?,(.*)$/s;

/** Parse a data URL into its media type + decoded bytes (base64 or percent). */
function parseDataUrl(dataUrl: string): { mediaType: string; bytes: Uint8Array } | null {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  const mediaType = m[1] || "application/octet-stream";
  const isBase64 = !!m[2];
  const raw = m[3] ?? "";
  try {
    const buf = isBase64 ? Buffer.from(raw, "base64") : Buffer.from(decodeURIComponent(raw), "utf8");
    return { mediaType, bytes: new Uint8Array(buf) };
  } catch {
    return null;
  }
}

/**
 * Build the dsh user-message content blocks for a text prompt + optional
 * attachments. Images are admitted through the mounted attachment store and
 * emitted as ImageBlocks; PDFs degrade to a text notice (dsh's ContentBlock
 * union has no document block). Falls back to text-only when no store is
 * mounted or an attachment can't be processed — nothing is thrown, so a bad
 * attachment never fails the whole turn.
 *
 * @returns content blocks in message order (text first, then attachments).
 */
export async function buildCordisUserContent(
  ctx: Context,
  text: string,
  attachments: readonly MessageAttachment[] | undefined,
): Promise<UserContentBlock[]> {
  const blocks: UserContentBlock[] = [{ type: "text", text }];
  if (!attachments || attachments.length === 0) return blocks;

  const store = (ctx as unknown as { get: (n: string) => unknown }).get("attachments") as AttachmentStore | undefined;

  for (const att of attachments) {
    const parsed = parseDataUrl(att.dataUrl);
    if (!parsed) continue;
    const isPdf = att.kind === "pdf" || parsed.mediaType === "application/pdf";

    if (isPdf) {
      // dsh's ContentBlock union has no document block, and PDF text extraction
      // would pull pdfjs into the Electron main bundle. For v1 we degrade
      // gracefully: tell the model a PDF was attached (so it can ask the user to
      // paste the relevant text) rather than silently dropping it. Full PDF
      // passthrough is tracked as a follow-up.
      blocks.push({
        type: "text",
        text: `\n\n[A PDF${att.name ? ` "${att.name}"` : ""} was attached, but PDF attachments are not yet supported on this engine. Ask the user to paste the relevant text if you need its contents.]`,
      });
      continue;
    }

    // Image: admit through the store → ImageBlock.
    if (!store) continue;
    const mediaType = parsed.mediaType as ImageMediaType;
    if (!store.imageLimits.mediaTypes.includes(mediaType)) continue;
    try {
      const ref = await store.saveImage({ data: parsed.bytes, mediaType, ...(att.name ? { name: att.name } : {}) });
      blocks.push({ type: "image", attachment: ref });
    } catch { /* omit an image the store rejects (too large / bad bytes) */ }
  }
  return blocks;
}
