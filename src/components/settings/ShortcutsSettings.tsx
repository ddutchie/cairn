"use client";

import React, { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./shared";

export function ShortcutsSettings() {
  const [mod, setMod] = useState("⌘");

  useEffect(() => {
    if (typeof window !== "undefined" && window.electron?.platform === "win32") {
      setMod("Ctrl");
    }
  }, []);

  const groups: { heading: string; shortcuts: { key: string; action: string }[] }[] = [
    {
      heading: "Navigation",
      shortcuts: [
        { key: `${mod}+1`, action: "Overview" },
        { key: `${mod}+2`, action: "Notes" },
        { key: `${mod}+3`, action: "Board" },
        { key: `${mod}+4`, action: "Idea Flow" },
        { key: `${mod}+5`, action: "Agent" },
        { key: `${mod}+6`, action: "Knowledge Graph" },
        { key: `${mod}+7`, action: "Insights" },
      ],
    },
    {
      heading: "Actions",
      shortcuts: [
        { key: `${mod}+K`, action: "Search" },
        { key: `${mod}+N`, action: "New note" },
        { key: `${mod}+/`, action: "Toggle AI chat" },
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
