"use client";

/**
 * Shared Cairn reference chip + action lookup tables.
 *
 * Used by the shared conversation renderer and live tool indicators for rendering the
 * clickable chip that results from a tool call writing a note or task.
 *
 * Previously duplicated across the Chat and Agent message bubbles.
 */

import { FileText, SquareCheck, CheckCircle, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { prettifyToolLabel } from "@/lib/utils";
import { revealNote, revealCard } from "@/lib/events";
import { useCairnStore } from "@/store";

// ── Action label lookup ──────────────────────────────────────────────────────

export const CAIRN_NOTE_ACTIONS: Record<string, string> = {
  create_note:     "Created note",
  ensure_note:     "Saved note",
  update_note:     "Updated note",
  patch_note:      "Patched note",
  append_to_note:  "Appended to note",
  get_note:        "Read note",
};

export const CAIRN_TASK_ACTIONS: Record<string, string> = {
  create_task:        "Created task",
  update_task:        "Updated task",
  update_task_status: "Moved task",
  get_task:           "Read task",
};

// ── Shared chip component ────────────────────────────────────────────────────

export interface CairnRef {
  type: "note" | "task";
  id: string;
  title: string;
}

const NOTE_TOOLS = new Set([
  "get_note", "ensure_note", "patch_note", "append_to_note", "rename_note", "instantiate_template", "create_note", "delete_note",
]);
const TASK_TOOLS = new Set([
  "get_task", "create_task", "update_task", "update_task_status", "delete_task",
]);

export function extractCairnRef(
  toolName: string,
  output: unknown,
): CairnRef | undefined {
  if (!output) return undefined;
  const isNote = NOTE_TOOLS.has(toolName);
  const isTask = TASK_TOOLS.has(toolName);
  if (!isNote && !isTask) return undefined;
  try {
    const parsed = typeof output === "string" ? JSON.parse(output) : output;
    const refId = parsed?.id;
    const refTitle = parsed?.title ?? parsed?.name ?? "(untitled)";
    if (!refId) return undefined;
    return { type: isNote ? "note" : "task", id: String(refId), title: String(refTitle) };
  } catch {
    return undefined;
  }
}


export function CairnRefChip({ toolName, cairnRef, ok = true }: {
  /** The MCP tool name — used to look up the action label (e.g. "create_note", "update_task"). */
  toolName: string;
  cairnRef: CairnRef;
  /** When `false`, the chip is styled as failed (non-clickable, danger border). Agent-only. */
  ok?: boolean;
}) {
  const setView = useCairnStore((s) => s.setView);
  const sessionPresentation = useCairnStore((s) => s.sessionPresentation);
  const setActivePreviewItem = useCairnStore((s) => s.setActivePreviewItem);
  const isNote = cairnRef.type === "note";
  const actionLabel = isNote
    ? (CAIRN_NOTE_ACTIONS[toolName] ?? "Updated note")
    : (CAIRN_TASK_ACTIONS[toolName] ?? "Updated task");

  function handleClick() {
    if (sessionPresentation === "center") {
      setActivePreviewItem({ type: cairnRef.type, id: cairnRef.id });
    } else if (isNote) {
      revealNote(setView, cairnRef.id);
    } else {
      revealCard(setView, cairnRef.id);
    }
  }

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex items-center gap-2 px-2.5 py-1.5 rounded-lg w-fit text-left transition-colors group",
        "bg-[var(--surface-2)] border border-[var(--border)]",
        "hover:border-[color-mix(in_srgb,var(--accent)_50%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_4%,var(--surface-2))]",
        !ok && "border-[color-mix(in_srgb,var(--danger)_30%,transparent)] opacity-60 pointer-events-none",
      )}
    >
      <div className={cn(
        "w-5 h-5 rounded flex items-center justify-center flex-shrink-0",
        isNote
          ? "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
          : "bg-[color-mix(in_srgb,var(--success)_12%,transparent)]",
      )}>
        {isNote
          ? <FileText size={10} className="text-[var(--accent)]" />
          : <SquareCheck size={10} className="text-[color-mix(in_srgb,var(--success)_90%,var(--text-primary))]" />
        }
      </div>

      <div className="flex flex-col min-w-0">
        <span className="text-[0.643rem] text-[var(--text-tertiary)] leading-none mb-0.5">{actionLabel}</span>
        <span className="text-[0.714rem] font-medium text-[var(--text-primary)] truncate max-w-[200px] leading-none group-hover:text-[var(--accent)] transition-colors">
          {cairnRef.title}
        </span>
      </div>

      <CheckCircle size={9} className={cn("shrink-0 ml-auto", ok ? "text-[var(--accent)]" : "text-[var(--danger)]")} />
    </button>
  );
}

// ── External reference chip (MCP / custom-service results) ───────────────────

export interface ExternalRef {
  url: string;
  title?: string;
  snippet?: string;
}

/** Best-effort friendly host for the sub-label (e.g. "github.com"). */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Clickable chip for a linkable artefact returned by an MCP-server / custom-HTTP
 * -service tool call (a Confluence page, web-search hit, GitHub PR, …). Opens the
 * URL in the system browser. The URL is already http(s)-validated at extraction
 * time (electron/lib/external-ref.ts) and re-guarded at the openExternal IPC.
 */
export function ExternalRefChip({ toolName, externalRef }: { toolName?: string; externalRef: ExternalRef }) {
  const label = externalRef.title || hostOf(externalRef.url);
  const sub = externalRef.title ? hostOf(externalRef.url) : (toolName ? prettifyToolLabel(toolName) : "Open link");

  function handleClick() {
    window.electron?.openExternal(externalRef.url);
  }

  return (
    <button
      onClick={handleClick}
      title={externalRef.snippet ? `${externalRef.url}\n\n${externalRef.snippet}` : externalRef.url}
      className={cn(
        "flex items-center gap-2 px-2.5 py-1.5 rounded-lg w-fit max-w-full text-left transition-colors group",
        "bg-[var(--surface-2)] border border-[var(--border)]",
        "hover:border-[color-mix(in_srgb,var(--accent)_50%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_4%,var(--surface-2))]",
      )}
    >
      <div className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]">
        <ExternalLink size={10} className="text-[var(--accent)]" />
      </div>
      <div className="flex flex-col min-w-0">
        <span className="text-[0.714rem] font-medium text-[var(--text-primary)] truncate max-w-[220px] leading-none group-hover:text-[var(--accent)] transition-colors">
          {label}
        </span>
        <span className="text-[0.643rem] text-[var(--text-tertiary)] leading-none mt-0.5 truncate max-w-[220px]">{sub}</span>
      </div>
    </button>
  );
}
