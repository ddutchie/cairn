"use client";

import { useState, type RefObject } from "react";
import { CheckCircle2, ChevronDown, FileDown, FileText, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { prepareNoteHtmlForPdf } from "./note-pdf-export";
import { resolveFontPreset } from "../../../shared/ui/fonts";
import type { FontFamilyId } from "@/store/slices/ui-appearance";

type ExportState = "idle" | "exporting" | "done";

const isElectronRenderer = () => typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

/**
 * Read-mode export button: PDF (light / dark) or Markdown. Desktop uses the
 * native save dialogs.
 */
export function NoteExportMenu({ noteId, title, proseRef, fontFamilyId }: {
  noteId: string;
  title: string;
  /** The rendered note, whose HTML becomes the PDF. */
  proseRef: RefObject<HTMLDivElement | null>;
  fontFamilyId: FontFamilyId;
}) {
  const [state, setState] = useState<ExportState>("idle");
  const [open, setOpen] = useState(false);

  const run = async (label: string, job: () => Promise<boolean | void>) => {
    setOpen(false);
    setState("exporting");
    try {
      // A job returns false when the user cancelled (nothing was saved).
      if ((await job()) === false) { setState("idle"); return; }
      setState("done");
      setTimeout(() => setState("idle"), 2000);
    } catch (err) {
      console.error(`${label} export failed:`, err);
      setState("idle");
    }
  };

  const exportPdf = (theme: "light" | "dark") => run("PDF", async () => {
    if (!proseRef.current) return false;
    const isElectron = isElectronRenderer();
    // Print-friendly code blocks (light-palette remap, no Copy button).
    const html = prepareNoteHtmlForPdf(proseRef.current.innerHTML, theme);
    // The note font's CSS stack, so the PDF matches the editor (system stacks
    // only — bundled webfonts won't load in the print engine).
    const fontFamily = resolveFontPreset(fontFamilyId).cssFamily;

    if (isElectron && window.electron?.exportNotePdf) {
      // Desktop returns null when the save dialog was cancelled.
      return (await window.electron.exportNotePdf(title, html, { theme, fontFamily })) ? undefined : false;
    } else {
      window.print();
    }
  });

  const exportMarkdown = () => run("Markdown", async () => {
    if (!window.electron?.exportMarkdown) return;
    // Desktop returns null when the save dialog was cancelled.
    return (await window.electron.exportMarkdown("note", noteId)) ? undefined : false;
  });

  return (
    <DropdownMenu open={open && state === "idle"} onOpenChange={setOpen}>
      <Tooltip content="Export note" disabled={open}>
        <DropdownMenuTrigger asChild>
        <button
          disabled={state === "exporting"}
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors whitespace-nowrap",
            state === "done"
              ? "text-[var(--success)]"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] disabled:opacity-50",
          )}
        >
          {state === "exporting"
            ? <Spinner size={12} />
            : state === "done"
              ? <CheckCircle2 size={12} />
              : <FileDown size={12} />}
          {state === "done" ? "Saved" : "PDF"}
          {state === "idle" && <ChevronDown size={10} className="opacity-60" />}
        </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[8rem]">
        <DropdownMenuItem onSelect={() => void exportPdf("light")}>
          <Sun size={12} /> PDF, light
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportPdf("dark")}>
          <Moon size={12} /> PDF, dark
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void exportMarkdown()}>
          <FileText size={12} /> Markdown
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
