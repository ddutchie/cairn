/**
 * Cairn — IPC handler for `app:exportMarkdown`.
 *
 * Serialises a single note or an entire project to a clean, self-contained
 * markdown document (via the shared, unit-tested builders in
 * `shared/notes/export.ts`, wrapped by `serializeNoteMarkdown` /
 * `serializeProjectMarkdown`). Either saves to disk via a native dialog, or
 * returns the markdown string so the renderer can copy it to the clipboard.
 */

import { dialog } from "electron";
import fs from "fs";
import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { getSnapshot } from "../mcp/db";
import { serializeNoteMarkdown, serializeProjectMarkdown } from "../shared/read-tools-pure";

/** Strip characters that are invalid in filenames on macOS/Windows. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, "_").trim() || "untitled";
}

interface ExportArgs {
  kind: "note" | "project";
  id: string;
  /** When true, return the markdown string instead of showing a save dialog. */
  returnText?: boolean;
}

export function registerMarkdownExportHandler(ctx: DbContext): void {
  registerIpcHandle(
    "app:exportMarkdown",
    (_e, { kind, id, returnText }: ExportArgs) =>
      handle(async () => {
        const snap = getSnapshot(ctx.db);
        const result = kind === "note"
          ? serializeNoteMarkdown(snap, id)
          : serializeProjectMarkdown(snap, id);

        if ("error" in result) throw new Error(result.error);
        const { markdown, title } = result;

        if (returnText) return { markdown, title };

        const activeWin = ctx.getWin();
        if (!activeWin || activeWin.isDestroyed()) throw new Error("No window");

        const { canceled, filePath } = await dialog.showSaveDialog(activeWin, {
          title: kind === "note" ? "Export Note as Markdown" : "Export Project as Markdown",
          defaultPath: `${sanitizeFilename(title)}.md`,
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (canceled || !filePath) return null;

        await fs.promises.writeFile(filePath, markdown, "utf-8");
        return { filePath };
      })
  );
}
