"use client";

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { ToolPanel } from "@/components/shared/ToolCard";
import type { ConversationToolCall } from "@/lib/conversation/message";
import { cn } from "@/lib/utils";
import {
  cairnToolView as cairnToolViewModel,
  type ChangeRowData,
  type ToolBlock,
  type ToolPanelData,
} from "../../../shared/conversation/tool-view";

/**
 * Renders the "what changed" panels for Cairn's own tools. What each panel says is
 * decided in `shared/conversation/tool-view.ts` (the mobile chat renders the same
 * model); this file only lays the blocks out.
 */

/** A single `field  from → to` row. */
export function ChangeRow({ field, from, to }: ChangeRowData) {
  return (
    <div className="grid grid-cols-[minmax(4.5rem,24%)_1fr] items-baseline gap-2 text-2xs">
      <span className="text-[var(--text-tertiary)]">{field}</span>
      <span className="min-w-0 break-words text-[var(--text-secondary)]">
        {from !== undefined && <span className="text-[var(--text-tertiary)] line-through decoration-[color-mix(in_srgb,var(--text-tertiary)_60%,transparent)]">{from}</span>}
        {from !== undefined && to !== undefined && <ArrowRight size={9} className="mx-1 inline text-[var(--text-tertiary)]" />}
        {to !== undefined && <span className="font-medium text-[var(--text-primary)]">{to}</span>}
      </span>
    </div>
  );
}

function Rows({ rows }: { rows: ChangeRowData[] }) {
  return <div className="space-y-0.5">{rows.map((r, i) => <ChangeRow key={`${r.field}-${i}`} {...r} />)}</div>;
}

function DiffLines({ rows, hidden }: Extract<ToolBlock, { type: "diff" }>) {
  return (
    <div className="overflow-hidden rounded border border-[var(--border)] font-mono text-2xs leading-5">
      {rows.map((row, i) => (
        <div
          key={i}
          className={cn("flex gap-1.5 px-1.5", row.sign === "+"
            ? "bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--text-primary)]"
            : "bg-[color-mix(in_srgb,var(--danger)_9%,transparent)] text-[var(--text-secondary)]")}
        >
          <span aria-hidden className={cn("select-none", row.sign === "+" ? "text-[var(--success)]" : "text-[var(--danger)]")}>{row.sign}</span>
          <span className="sr-only">{row.sign === "+" ? "Added: " : "Removed: "}</span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{row.text || " "}</span>
        </div>
      ))}
      {hidden > 0 && <div className="px-1.5 text-[var(--text-tertiary)]">+{hidden} more lines</div>}
    </div>
  );
}

function Block({ block }: { block: ToolBlock }): ReactNode {
  switch (block.type) {
    case "groups":
      return (
        <div className="space-y-1.5">
          {block.groups.map((g, i) => (
            <div key={`${g.title}-${i}`}>
              <p className="truncate text-xs font-medium text-[var(--text-primary)]">{g.title}</p>
              <div className="mt-0.5 space-y-0.5 border-l border-[var(--border)] pl-2"><Rows rows={g.rows} /></div>
            </div>
          ))}
        </div>
      );
    case "rows":
      return <Rows rows={block.rows} />;
    case "diff":
      return <DiffLines {...block} />;
    case "text":
      return <p className={cn("text-2xs", block.muted ? "text-[var(--text-tertiary)]" : "text-[var(--text-secondary)]")}>{block.text}</p>;
    case "caption":
      return <p className="mt-1 text-2xs text-[var(--text-tertiary)]">{block.text}</p>;
    case "heading":
      return <p className="text-xs font-medium text-[var(--text-primary)]">{block.text}{block.note && <span className="ml-1.5 text-2xs font-normal text-[var(--text-tertiary)]">{block.note}</span>}</p>;
    case "chips":
      return (
        <div className="mt-1 flex flex-wrap gap-1">
          {block.items.map((item, i) => (
            <span key={`${item}-${i}`} className="max-w-full truncate rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-2xs text-[var(--text-secondary)]">{item}</span>
          ))}
        </div>
      );
    case "hits":
      return (
        <>
          <ul className="space-y-0.5">
            {block.items.map((h, i) => (
              <li key={`${h.title}-${i}`} className="flex items-baseline justify-between gap-2 text-2xs">
                <span className="min-w-0 truncate text-[var(--text-primary)]">{h.title}</span>
                {h.hint && <span className="shrink-0 text-[var(--text-tertiary)]">{h.hint}</span>}
              </li>
            ))}
          </ul>
          {block.more > 0 && <p className="mt-1 text-2xs text-[var(--text-tertiary)]">+{block.more} more</p>}
        </>
      );
    case "list":
      return (
        <>
          <ul className="space-y-0.5">
            {block.items.map((p, i) => (
              <li key={`${p.name}-${i}`} className="flex items-baseline justify-between gap-2 text-2xs">
                <span className="min-w-0 truncate"><span className="font-medium text-[var(--text-primary)]">{p.name}</span>{p.meta && <span className="ml-1.5 text-[var(--text-tertiary)]">{p.meta}</span>}</span>
                {p.tail && <span className="shrink-0 text-[var(--text-tertiary)]">{p.tail}</span>}
              </li>
            ))}
          </ul>
          {block.more > 0 && <p className="mt-1 text-2xs text-[var(--text-tertiary)]">+{block.more} more</p>}
        </>
      );
    case "sentence":
      return (
        <p className="min-w-0 truncate text-2xs text-[var(--text-secondary)]">
          {block.parts.map((p, i) => <span key={i} className={p.strong ? "text-[var(--text-primary)]" : undefined}>{p.text}</span>)}
        </p>
      );
  }
}

function Panel({ data }: { data: ToolPanelData }) {
  return (
    <ToolPanel label={data.label} className={data.tone === "danger" ? "border-[color-mix(in_srgb,var(--danger)_35%,var(--border))]" : undefined}>
      {data.blocks.map((b, i) => <Block key={i} block={b} />)}
    </ToolPanel>
  );
}

/**
 * The "what changed" panels for a Cairn tool call, or null to use the generic panels.
 * `pending` is for an approval card: nothing has run, so wording is future tense.
 */
export function cairnToolView(tc: ConversationToolCall, opts: { pending?: boolean } = {}): ReactNode | null {
  const panels = cairnToolViewModel(tc, opts);
  if (!panels) return null;
  return <>{panels.map((p, i) => <Panel key={i} data={p} />)}</>;
}
