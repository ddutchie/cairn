"use client";

import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { modKey } from "@/components/layout/sidebar-utils";
import { SettingsGroup } from "./shared";

export function ShortcutsSettings() {
  const { hiddenViews } = useCairnStore(useShallow((s) => ({ hiddenViews: s.hiddenViews })));

  // Platform modifier as a bare token ("⌘" / "Ctrl") so `${mod}+1` reads
  // "⌘+1" on mac and "Ctrl+1" elsewhere — matches the sidebar/topbar hints.
  const [mod] = useState(() => modKey().replace(/\+$/, ""));

  // Dynamic navigation shortcuts — mirrors page.tsx ORDERED_VIEWS logic
  const navViews = (["board", "flow", "agent", "graph", "insights"] as const).filter(
    (v) => !hiddenViews.has(v)
  );
  const navShortcuts = [
    { key: `${mod}+1`, action: "Overview" },
    { key: `${mod}+2`, action: "Notes" },
    ...navViews.map((v, i) => ({
      key: `${mod}+${i + 3}`,
      action: v === "graph" ? "Knowledge Graph" : v === "flow" ? "Idea Flow" : v.charAt(0).toUpperCase() + v.slice(1),
    })),
  ];
    const groups: { heading: string; shortcuts: { key: string; action: string }[] }[] = [
    {
      heading: "Navigation",
      shortcuts: navShortcuts,
    },
    {
      heading: "Actions",
      shortcuts: [
        { key: `${mod}+K`, action: "Search" },
        { key: `${mod}+N`, action: "New note" },
        ...(hiddenViews.has("chat") ? [] : [{ key: `${mod}+/`, action: "Toggle AI chat" }]),
        { key: `${mod}+\\`, action: "Toggle sidebar" },
      ],
    },
    {
      heading: "Editing",
      shortcuts: [
        { key: `${mod}+Z`, action: "Undo" },
        { key: `${mod}+⇧+Z`, action: "Redo" },
        { key: `${mod}+S`, action: "Save file (Agent editor)" },
      ],
    },
    {
      heading: "Search",
      shortcuts: [
        { key: "Esc", action: "Close / cancel" },
        { key: "↑↓", action: "Navigate results" },
        { key: "↵", action: "Open result" },
      ],
    },
  ];

  return (
    <SettingsGroup title="Keyboard Shortcuts">
      <div className="space-y-4">
        {groups.map(({ heading, shortcuts }) => (
          <div key={heading}>
            <p className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] mb-1.5 px-1">
              {heading}
            </p>
            <div className="border border-[var(--border)] rounded-lg overflow-hidden">
              {shortcuts.map(({ key, action }, i) => (
                <div
                  key={key}
                  className={cn(
                    "flex items-center justify-between px-4 py-2.5",
                    i > 0 && "border-t border-[var(--border-subtle)]"
                  )}
                >
                  <span className="text-xs text-[var(--text-secondary)]">{action}</span>
                  <kbd className="text-[0.786rem] font-mono bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-0.5 text-[var(--text-tertiary)]">
                    {key}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SettingsGroup>
  );
}
