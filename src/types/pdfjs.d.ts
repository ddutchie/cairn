/**
 * pdf.js worker module — imported on the main thread as a "fake worker" so
 * PDF rendering works without a real Web Worker (and without CDN fetching).
 * The module self-registers `globalThis.pdfjsWorker.WorkerMessageHandler`, and
 * the pdf.js API picks it up for main-thread rendering.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs" {
  export const WorkerMessageHandler: unknown;
}
