"use client";

import { useState } from "react";
import { CheckCircle, Copy, ChevronDown, ChevronUp, FileCode, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { InventoryToolView } from "./useAgentPreviews";

// ── Prompt preview (shared by Chat + Coding Agents tabs) ────────────────────

export function PromptPreview({ systemPrompt }: { systemPrompt: string }) {
  const [expanded, setExpanded] = useState(false);
  const { copied, copy: copyToClipboard } = useCopyToClipboard();

  const lines = systemPrompt.split("\n");
  const PREVIEW_LINES = 6;
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const hasMore = lines.length > PREVIEW_LINES;

  function copy() {
    copyToClipboard(systemPrompt);
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-[var(--border)] bg-[var(--surface-2)]">
        <div className="flex items-center gap-2">
          <FileCode size={12} className="text-[var(--text-tertiary)]" />
          <span className="text-xs font-medium text-[var(--text-secondary)]">System prompt</span>
          <span className="text-[0.65rem] text-[var(--text-tertiary)]">({lines.length} lines)</span>
        </div>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-2 py-1 rounded hover:bg-[var(--surface-3)]"
        >
          {copied
            ? <><CheckCircle size={11} className="text-[var(--success)]" /> Copied</>
            : <><Copy size={11} /> Copy</>
          }
        </button>
      </div>

      {/* Content */}
      <div className="relative">
        <pre className="text-[0.714rem] font-mono text-[var(--text-secondary)] leading-relaxed p-4 overflow-x-auto whitespace-pre-wrap break-words">
          {expanded ? systemPrompt : preview}
        </pre>
        {!expanded && hasMore && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[var(--surface)] to-transparent pointer-events-none" />
        )}
      </div>

      {/* Expand toggle */}
      {hasMore && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-center gap-1.5 py-2.5 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] border-t border-[var(--border)] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] transition-colors"
        >
          {expanded
            ? <><ChevronUp size={12} /> Collapse</>
            : <><ChevronDown size={12} /> Show all ({lines.length} lines)</>
          }
        </button>
      )}
    </div>
  );
}

/** One assembled prompt section, expandable to show its literal text. */
export function SectionPreview({ name, text, index }: { name: string; text: string; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text && text.length > 90 ? `${text.slice(0, 90)}…` : text;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-[var(--surface-2)] transition-colors"
        aria-expanded={expanded}
      >
        <span className="text-[0.65rem] font-mono text-[var(--text-tertiary)] w-5 shrink-0 text-right">{index + 1}</span>
        <span className="text-[0.714rem] font-mono text-[var(--accent)] shrink-0">{name}</span>
        {text && (
          <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate flex-1">{expanded ? "" : preview}</span>
        )}
        <ChevronDown size={12} className={`text-[var(--text-tertiary)] shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <pre className="text-[0.714rem] font-mono text-[var(--text-secondary)] leading-relaxed px-3 py-2 border-t border-[var(--border)] overflow-x-auto whitespace-pre-wrap break-words">
          {text || "(empty section)"}
        </pre>
      )}
    </div>
  );
}

// ── Shared global sections (identical for chat + coding agent) ──────────────
// These come from globally-mounted dsh plugins (tool:jobs, tool:web_fetch,
// tool:goal, tool:delegate, …) plus Cairn's own cairn:system identity. Only
// the cairn:system CONTENT differs per surface — everything else here is the
// same assembly both turns send. Empty placeholders (deployment:persona,
// idle plan:policy) are hidden with a footnote instead of rendered as rows.

export function isEmptySectionText(text: string): boolean {
  return text.trim().length === 0;
}

export function SharedSectionsList({
  sections,
  skillsCount,
  toolsCount,
}: {
  sections: Array<{ name: string; text: string; index: number }>;
  skillsCount?: number;
  toolsCount?: number;
}) {
  const visible = sections.filter((s) => !isEmptySectionText(s.text));
  const hidden = sections.filter((s) => isEmptySectionText(s.text));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[0.714rem] text-[var(--text-tertiary)]">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--surface-3)]">
          {visible.length} shared section{visible.length !== 1 ? "s" : ""}
        </span>
        {skillsCount !== undefined && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--surface-3)]">
            {skillsCount} skills
          </span>
        )}
        {toolsCount !== undefined && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--surface-3)]">
            {toolsCount} tools
          </span>
        )}
      </div>
      <p className="text-[0.65rem] text-[var(--text-tertiary)]">
        Global dsh assembly — identical for chat and coding agent turns. Only the identity section content differs per surface (shown below).
      </p>
      {visible.map((s) => <SectionPreview key={`${s.index}-${s.name}`} name={s.name} text={s.text} index={s.index} />)}
      {hidden.length > 0 && (
        <p className="text-[0.65rem] text-[var(--text-tertiary)]">
          Hidden when empty: {hidden.map((s) => s.name).join(", ")}
        </p>
      )}
    </div>
  );
}
// Same card, dots, badges, and legend everywhere — only the tool list differs.

// ── Tools panel (shared by Chat / Coding Agents / MCP tabs) ─────────────────
// Same card, dots, badges, and legend everywhere — only the tool list differs.

export function categoryDot(category: string): string {
  return category === "write"
    ? "bg-[var(--warning)]"
    : category === "delete"
      ? "bg-[var(--danger)]"
      : category === "exec"
        ? "bg-[var(--success)]"
        : "bg-[var(--accent)]";
}

export function ToolsLegend() {
  return (
    <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-2">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent)] mr-1" />read &nbsp;
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--warning)] mr-1" />write &nbsp;
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--danger)] mr-1" />delete &nbsp;
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--success)] mr-1" />exec
    </p>
  );
}

export function SurfaceToolsPanel({
  tools,
  footnote,
}: {
  tools: InventoryToolView[];
  footnote?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-[var(--border)] bg-[var(--surface-2)]">
        <Wrench size={12} className="text-[var(--text-tertiary)]" />
        <span className="text-xs font-medium text-[var(--text-secondary)]">Tools ({tools.length})</span>
      </div>
      <div className="p-2 space-y-1 max-h-80 overflow-y-auto">
        {tools.map((t) => (
          <div key={`${t.source}:${t.name}`} className="px-2 py-1.5 rounded hover:bg-[var(--surface-2)]">
            <div className="flex items-center gap-1.5">
              <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", categoryDot(t.category))} />
              <span className="text-[0.714rem] font-mono text-[var(--accent)]">{t.name}</span>
              {t.source !== "cairn" && (
                <span className="text-[0.65rem] px-1 py-px rounded bg-[var(--surface-3)] text-[var(--text-tertiary)]">
                  {t.source}
                </span>
              )}
              {t.gated && (
                <span className="text-[0.65rem] px-1 py-px rounded bg-[var(--surface-3)] text-[var(--warning)]">
                  approval-gated
                </span>
              )}
            </div>
            {t.description && <div className="text-[0.714rem] text-[var(--text-tertiary)] line-clamp-1">{t.description}</div>}
          </div>
        ))}
      </div>
      {footnote && (
        <div className="px-3.5 py-2 border-t border-[var(--border)] text-[0.65rem] text-[var(--text-tertiary)]">
          {footnote}
        </div>
      )}
    </div>
  );
}
