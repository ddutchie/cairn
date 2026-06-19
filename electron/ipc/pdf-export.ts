/**
 * Cairn — IPC handler for `app:exportNotePdf`.
 *
 * Wraps the note's already-rendered HTML in a self-contained light-theme document
 * (see `lib/pdf-template.ts`), loads it into a hidden BrowserWindow, and prints
 * to PDF. Either saves the file to disk or returns the PDF as base64 (used by
 * chat / agents that want to attach the PDF without a save dialog).
 *
 * Extracted from the 1054-line god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { dialog, BrowserWindow } from "electron";
import fs from "fs";
import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { buildPdfHtml, type PdfTheme } from "../lib/pdf-template";

/** Strip characters that are invalid in filenames on macOS/Windows. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, "_").trim() || "untitled";
}

export function registerPdfExportHandler(ctx: DbContext): void {
  registerIpcHandle(
    "app:exportNotePdf",
    (
      _e,
      { title, html, options }: { title: string; html: string; options?: { returnBuffer?: boolean; theme?: PdfTheme } }
    ) =>
      handle(async () => {
        const returnBuffer = options?.returnBuffer ?? false;
        const theme = options?.theme ?? "light";
        const safeTitle = sanitizeFilename(title);

        let savePath = "";
        if (!returnBuffer) {
          const activeWin = ctx.getWin();
          if (!activeWin || activeWin.isDestroyed()) throw new Error("No window");

          const { canceled, filePath } = await dialog.showSaveDialog(activeWin, {
            title: "Export Note as PDF",
            defaultPath: `${safeTitle}.pdf`,
            filters: [{ name: "PDF Document", extensions: ["pdf"] }],
          });
          if (canceled || !filePath) return null;
          savePath = filePath;
        }

        const fullHtml = buildPdfHtml(title, html, theme);

        // Open a hidden window, load the HTML, print to PDF, then close
        const printWin = new BrowserWindow({
          show: false,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        });

        try {
          await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);

          const pdfBuffer = await printWin.webContents.printToPDF({
            printBackground: true,
            pageSize: "A4",
            // Margins are defined via @page in the HTML — use "default" so the
            // CSS @page rule is respected rather than being overridden here.
            margins: { marginType: "default" },
          });

          if (returnBuffer) {
            return { pdfBase64: pdfBuffer.toString("base64") };
          }

          await fs.promises.writeFile(savePath, pdfBuffer);
          return { filePath: savePath };
        } finally {
          printWin.destroy();
        }
      })
  );
}
