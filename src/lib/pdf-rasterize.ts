"use client";

/**
 * Cairn — PDF → image rasterization (desktop, browser only).
 *
 * Renders a PDF's pages to PNG data URLs so they can ride the universal
 * `image_url` chat content part — for models that accept images but not PDF
 * documents. Models whose catalog entry lists `pdf` input get the raw bytes
 * instead (see shared/models/pdf-attach.ts) — usually smaller and lossless.
 *
 * pdf.js runs in main-thread "fake worker" mode: importing the worker module
 * registers `globalThis.pdfjsWorker.WorkerMessageHandler`, which the pdf.js API
 * picks up without a real Web Worker — no CDN script, no asset-bundle wrangling
 * that Turbopack/static-export can't express (a `?url` import of the worker
 * module fails to compile).
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
import { dataUrlToBytes } from "./pdf-document";

// The worker module sets this global itself; assign again so the linkage is
// explicit and immune to bundler reordering. Fake-worker mode = main thread.
(globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

/** Cap on pages rasterized per PDF (a safety valve on token cost). */
export const MAX_RASTERIZE_PAGES = 8;
/** Cap on the longest rendered edge (pixels); keeps data-URL payloads sane. */
const MAX_EDGE = 2048;
/** Base render scale (CSS px per PDF point). */
const SCALE = 1.5;

async function openPdf(dataUrl: string): Promise<PDFDocumentProxy> {
  return getDocument({ data: dataUrlToBytes(dataUrl) }).promise;
}

/**
 * Rasterize up to `MAX_RASTERIZE_PAGES` pages of a PDF data URL into PNG data
 * URLs (white background). Throws when the PDF can't be parsed or a page can't
 * be rendered (the caller should skip/refuse the attachment on failure).
 */
export async function rasterizePdfToImages(dataUrl: string): Promise<string[]> {
  const doc = await openPdf(dataUrl);
  const pages = Math.min(doc.numPages, MAX_RASTERIZE_PAGES);
  const out: string[] = [];
  try {
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(SCALE, MAX_EDGE / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(vp.width));
      canvas.height = Math.max(1, Math.ceil(vp.height));
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Canvas 2D context unavailable");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // pdf.js 6: pass the canvas directly (required); it renders via its own
      // context. We keep `canvasContext` null and just painted the white bg.
      await page.render({ canvas, viewport: vp }).promise;
      out.push(canvas.toDataURL("image/png"));
      try {
        page.cleanup();
      } catch {
        /* best-effort */
      }
    }
    return out;
  } finally {
    try {
      await (doc as { destroy?: () => Promise<void> }).destroy?.();
    } catch {
      /* best-effort */
    }
  }
}
