/**
 * Cairn — chat attachment helpers (shared desktop + mobile).
 *
 * Attachments are carried as data URLs (base64). Images ride the standard
 * OpenAI-compatible `image_url` content part; PDFs are sent as a `document`
 * base64 part — the shape Anthropic-style endpoints (and most gateways that
 * serve models whose models.dev `modalities.input` lists `pdf`) accept. We only
 * attach a PDF when the active model is known to take PDF input, so the bytes
 * go straight through instead of being rasterized (smaller, lossless).
 *
 * No rasterization here: a caller that wants to send a PDF to a non-pdf model
 * must render pages to images itself and send those as image attachments.
 */

import type { ModelInfo } from "./model-catalog";

/** A chat attachment, normalized to a data URL (image or PDF). */
export interface ChatAttachment {
  kind: "image" | "pdf";
  /** base64 data URL, e.g. data:image/png;base64,… or data:application/pdf;base64,… */
  dataUrl: string;
  name?: string;
}

/** A single content part inside an OpenAI-style message `content` array. */
export type ContentPart = { type: string } & Record<string, unknown>;

/** Maximum size (bytes) of a single image/PDF attachment (desktop + mobile). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Runtime validation of an attachment data URL before it is turned into a
 * content part or persisted. Rejects anything that isn't a `data:` URL with a
 * supported image/PDF MIME type whose base64 payload decodes within
 * MAX_ATTACHMENT_BYTES. Returns an error message, or null when the URL is valid.
 */
export function validateAttachmentDataUrl(dataUrl: unknown): string | null {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    return "attachment is missing a data URL";
  }
  if (!dataUrl.startsWith("data:")) {
    return "attachment must be a data: URL";
  }
  // Early cap on total data URL length to prevent slicing huge strings (M2).
  // 35M chars ≈ ~26M decoded bytes + header, safely above MAX_ATTACHMENT_BYTES.
  if (dataUrl.length > 35_000_000) {
    return `attachment exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB size limit`;
  }
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return "malformed data: URL (missing payload)";
  const header = dataUrl.slice(5, comma).toLowerCase();
  // Require ;base64 marker — non-base64 data URLs are not supported.
  if (!header.includes(";base64")) {
    return "attachment must be base64-encoded (missing ;base64)";
  }
  const mime = header.split(";")[0];
  if (mime !== "application/pdf" && !mime.startsWith("image/")) {
    return `unsupported attachment MIME type: ${mime}`;
  }
  try {
    let b64 = dataUrl.slice(comma + 1);
    // Strip whitespace (newlines/spaces) that may be injected — base64 ignores it but we validate strictly.
    b64 = b64.replace(/\s/g, "");
    if (b64.length === 0) return "attachment has invalid base64 encoding";
    // Base64 alphabet + padding only; reject semicolons/control chars that would have been sliced incorrectly.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
      return "attachment has invalid base64 encoding";
    }
    if (b64.length % 4 !== 0) {
      return "attachment has invalid base64 encoding";
    }
    // Validate via length without allocating Buffer; also caps decoded size.
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const len = Math.floor(b64.length * 3 / 4) - padding;
    if (len > MAX_ATTACHMENT_BYTES) {
      return `attachment exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB size limit`;
    }
    // Reject negative/overflow from malformed padding
    if (len < 0) return "attachment has invalid base64 encoding";
  } catch {
    return "attachment has invalid base64 encoding";
  }
  return null;
}

/** Whether a model (or the catalog) says it accepts PDF input. Unknown models
 *  are NOT assumed pdf-capable — PDF attach stays a known capability. */
export function supportsPdfInput(info: ModelInfo | null): boolean {
  return info ? (info.modes ?? []).includes("pdf") : false;
}

/** Strip the data URL prefix to the raw base64 payload. */
function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** Anthropic-style `document` content part carrying raw PDF bytes. */
export function pdfDocumentPart(dataUrl: string): ContentPart {
  return {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: base64Of(dataUrl) },
  };
}

/** Standard OpenAI-compatible `image_url` content part. */
export function imageUrlPart(dataUrl: string): ContentPart {
  return { type: "image_url", image_url: { url: dataUrl } };
}

/**
 * Build the `content` array for a user message from a text and its attachments.
 * PDFs must only arrive here when the model is pdf-capable (the caller gates
 * attachment on supportsPdfInput); image attachments are always forwarded.
 * `kind` is optional so legacy senders (no kind set) default to `image_url`.
 */
export function buildAttachmentParts(
  text: string,
  attachments: Array<{ kind?: "image" | "pdf"; dataUrl: string; name?: string }>,
): ContentPart[] {
  const parts: ContentPart[] = [{ type: "text", text }];
  for (const a of attachments) {
    parts.push(a.kind === "pdf" ? pdfDocumentPart(a.dataUrl) : imageUrlPart(a.dataUrl));
  }
  return parts;
}

/**
 * Token estimate for a document part. PDF pages bill roughly like images (and
 * much larger than their text would tokenize), so a flat conservative estimate
 * beats the raw base64 length (which over-counts by orders of magnitude).
 */
export const PDF_TOKEN_ESTIMATE = 2000;

/** Rough token estimate for a PDF data URL (document part), clamped. */
export function pdfTokenEstimate(dataUrl: string): number {
  const bytes = base64Of(dataUrl).length / 4 * 3;
  if (!Number.isFinite(bytes) || bytes <= 0) return PDF_TOKEN_ESTIMATE;
  // ~1 token per 2 bytes, floor at 0.5 pages, cap at ~8 pages.
  const tokens = bytes / 2;
  return Math.max(500, Math.min(8000, Math.round(tokens)));
}
