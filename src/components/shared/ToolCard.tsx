"use client";

import { useState, type ReactNode } from "react";
import { CheckCircle, ChevronDown, ChevronRight, XCircle } from "lucide-react";
import { MicroLabel } from "@/components/ui/labels";
import { Tooltip } from "@/components/ui/tooltip";
import type { HumanizedTool } from "@/lib/humanize-tool";
import { cn } from "@/lib/utils";

/**
 * Shared tool-call card: a compact status chip (icon · brand · action) that
 * expands into labelled panels. Connector (MCP / HTTP service) calls and
 * Cairn's own tools both render through it so every managed call looks and
 * expands the same way.
 */
export function ToolCard({
  testId,
  summaryTestId,
  ok,
  icon,
  brand,
  summary,
  tooltip,
  caption,
  defaultExpanded = false,
  children,
}: {
  testId?: string;
  summaryTestId?: string;
  ok: boolean;
  /** Identity mark: connector logo or the Cairn mark. */
  icon: ReactNode;
  /** Bold lead-in ("Linear", "Cairn"). */
  brand: string;
  summary: HumanizedTool;
  tooltip: string;
  /** Muted line at the top of the expanded body. */
  caption?: string;
  defaultExpanded?: boolean;
  /** Expanded panels (ToolPayload, ChangeList, chips…). */
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div data-testid={testId} className="max-w-xl">
      <Tooltip content={tooltip}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-fit max-w-full text-left hover:border-[var(--accent)] cursor-pointer"
        >
          {ok ? <CheckCircle size={9} className="shrink-0 text-[var(--accent)]" /> : <XCircle size={9} className="shrink-0 text-[var(--danger)]" />}
          {icon}
          <span data-testid={summaryTestId} className="min-w-0 truncate text-xs text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">{brand}</span>
            {" · "}{summary.pre}{summary.obj ? <> <strong className="font-medium text-[var(--text-primary)]">{summary.obj}</strong></> : null}{summary.post ? <> {summary.post}</> : null}{!ok && " failed"}
          </span>
          {expanded ? <ChevronDown size={9} className="shrink-0 text-[var(--text-tertiary)]" /> : <ChevronRight size={9} className="shrink-0 text-[var(--text-tertiary)]" />}
        </button>
      </Tooltip>
      {expanded && (
        <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
          {caption && <p className="text-2xs text-[var(--text-tertiary)]">{caption}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

/** Labelled panel: parsed JSON renders as a key/value tree, anything else as text. */
export function ToolPayload({ label, value }: { label: string; value: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  return (
    <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
      <MicroLabel className="mb-1 block">{label}</MicroLabel>
      {parsed !== undefined ? <JsonTree value={parsed} /> : <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-2xs leading-5 text-[var(--text-tertiary)]">{value}</pre>}
    </div>
  );
}

/** Labelled panel around arbitrary content (used by the per-tool views). */
export function ToolPanel({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("mt-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5", className)}>
      <MicroLabel className="mb-1 block">{label}</MicroLabel>
      {children}
    </div>
  );
}

function JsonTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) return <span className="text-[var(--text-tertiary)]">null</span>;
  if (typeof value !== "object") return <span className="break-words text-[var(--text-secondary)]">{typeof value === "string" ? `"${value}"` : String(value)}</span>;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  return (
    <div className="space-y-0.5 font-mono text-2xs">
      {entries.map(([key, child]) => {
        const nested = child !== null && typeof child === "object";
        return nested ? (
          <details key={key} open={depth < 1} className="border-l border-[var(--border)] pl-2">
            <summary className="cursor-pointer text-[var(--text-secondary)]">{key} <span className="text-[var(--text-tertiary)]">{Array.isArray(child) ? `[${child.length}]` : "{…}"}</span></summary>
            <JsonTree value={child} depth={depth + 1} />
          </details>
        ) : (
          <div key={key} className="grid grid-cols-[minmax(5rem,35%)_1fr] gap-2 border-l border-[var(--border)] pl-2">
            <span className="break-words text-[var(--text-tertiary)]">{key}</span>
            <JsonTree value={child} depth={depth + 1} />
          </div>
        );
      })}
    </div>
  );
}
