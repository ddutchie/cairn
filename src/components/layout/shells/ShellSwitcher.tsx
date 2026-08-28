"use client";

import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import type { ShellVariant } from "@/store/slices/ui";
import { useShallow } from "zustand/react/shallow";

const VARIANTS: Array<{ id: ShellVariant; label: string; sub: string }> = [
  { id: "current", label: "Current", sub: "84px" },
  { id: "A", label: "A · Rail", sub: "44px" },
  { id: "B", label: "B · Desk", sub: "well" },
  { id: "C", label: "C · Calm", sub: "52 rail" },
];

export function ShellSwitcher({ compact = false }: { compact?: boolean }) {
  const { shellVariant, setShellVariant } = useCairnStore(
    useShallow((s) => ({ shellVariant: s.shellVariant, setShellVariant: s.setShellVariant }))
  );

  return (
    <div
      className={cn(
        "flex items-center gap-1 p-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)]",
        compact && "p-0.5"
      )}
      role="tablist"
      aria-label="Shell preview"
    >
      {VARIANTS.map((v) => {
        const active = shellVariant === v.id;
        return (
          <button
            key={v.id}
            role="tab"
            aria-selected={active}
            onClick={() => setShellVariant(v.id)}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap",
              compact && "px-2 py-1 text-[0.714rem]",
              active
                ? "bg-[var(--text-primary)] text-[var(--background)] font-semibold shadow-sm"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface)]"
            )}
            title={v.id === "current" ? "Current shell (TitleBar + TopBar)" : `Preview ${v.label}`}
          >
            {v.label}
            {!compact && <span className="ml-1.5 opacity-60 font-normal hidden sm:inline">{v.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function ShellPreviewBanner() {
  const { shellVariant } = useCairnStore(useShallow((s) => ({ shellVariant: s.shellVariant })));
  if (shellVariant === "current") return null;
  return (
    <div className="flex items-center gap-3 px-3 h-8 bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] border-b border-[color-mix(in_srgb,var(--accent)_18%,transparent)] flex-shrink-0">
      <span className="text-[0.714rem] font-semibold tracking-[0.04em] uppercase text-[var(--accent)]">Shell preview</span>
      <span className="text-xs text-[var(--text-tertiary)] hidden sm:inline">
        You’re viewing <b className="text-[var(--text-secondary)]">{shellVariant === "A" ? "A · Unified Rail" : shellVariant === "B" ? "B · Studio Desk" : "C · Calm OS"}</b> with live tokens & data.
      </span>
      <span className="ml-auto hidden sm:inline text-[0.714rem] text-[var(--text-tertiary)]">⌘1–4 switches shells</span>
      <ShellSwitcher compact />
    </div>
  );
}
