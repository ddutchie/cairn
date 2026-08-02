/**
 * Cairn — PDF document loading (desktop).
 *
 * Node-safe wrapper around pdfjs-dist (legacy build, works in the renderer and
 * in vitest under plain Node) for opening a PDF from a data URL. Only exposes
 * what attachments need: the page count (used by the rasterizer and the token
 * estimate). The browser-only page-to-image rendering lives in
 * ./pdf-rasterize.ts.
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Decode a base64 data URL into a fresh Uint8Array. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Page count of a PDF data URL (throws on unparseable input). */
export async function pdfPageCount(dataUrl: string): Promise<number> {
  const doc = await getDocument({ data: dataUrlToBytes(dataUrl) }).promise;
  try {
    return doc.numPages;
  } finally {
    // Release worker resources (method name varies across pdfjs builds).
    try {
      await (doc as { destroy?: () => Promise<void> }).destroy?.();
    } catch {
      /* best-effort */
    }
  }
}
