/**
 * Cairn — PDF HTML template (desktop re-export shim).
 *
 * The implementation now lives in `shared/notes/pdf-template.ts` so both the
 * Electron desktop app (printToPDF) and the Expo mobile app (expo-print) build
 * the same self-contained document. This shim keeps the existing
 * `../lib/pdf-template` import path working.
 */
export { buildPdfHtml, buildPdfFooterTemplate, buildPdfHeaderTemplate, type PdfTheme } from "../../shared/notes/pdf-template";
