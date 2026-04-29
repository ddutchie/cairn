"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./shared";

export function ShortcutsSettings() {
  const shortcuts = [
    { key: "⌘K", action: "Open search" },
    { key: "⌘/", action: "Toggle AI chat" },
    { key: "⌘N", action: "New note" },
    { key: "⌘\\", action: "Toggle sidebar" },
    { key: "⌘1", action: "Project overview" },
    { key: "⌘2", action: "Notes view" },
    { key: "⌘3", action: "Board view" },
    { key: "Esc", action: "Close modal / search" },
    { key: "↑↓", action: "Navigate search results" },
    { key: "↵", action: "Open selected result" },
  ];

  return (
    <SettingsGroup title="Keyboard Shortcuts">
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
            <kbd className="text-[11px] font-mono bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-0.5 text-[var(--text-tertiary)]">
              {key}
            </kbd>
          </div>
        ))}
      </div>
    </SettingsGroup>
  );
}
