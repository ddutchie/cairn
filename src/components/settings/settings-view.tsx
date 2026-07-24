"use client";

import React, { useState } from "react";
import {
  Settings,
  Database,
  Bot,
  Keyboard,
  Info,
  Tag,
  Terminal,
  Smartphone,
  Network,
  Wrench,
  FolderSync,
} from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { GeneralSettings } from "./GeneralSettings";
import { AISettings } from "./AISettings";
import { TagsSettings } from "./TagsSettings";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { DataSettings } from "./DataSettings";
import { AboutSection } from "./AboutSection";
import { AgentSettings } from "./AgentSettings";
import { MobileSettings } from "./MobileSettings";
import { SyncSettings } from "./SyncSettings";
import { EmbeddingsSettings } from "./EmbeddingsSettings";
import { ToolsSettings } from "./ToolsSettings";
import type { SettingsSection } from "@/types";

export function SettingsView() {
  const { workspaces, projects, notes, cards, settingsSection, setSettingsSection } = useCairnStore(useShallow((s) => ({ workspaces: s.workspaces, projects: s.projects, notes: s.notes, cards: s.cards, settingsSection: s.settingsSection, setSettingsSection: s.setSettingsSection })));

  // Honour a requested target section (e.g. "open Tools" from the Overview) as
  // the initial section, then clear the request so it doesn't override manual
  // navigation later. Consumed once at mount.
  const [section, setSection] = useState<SettingsSection>(
    () => settingsSection ?? "general",
  );
  React.useEffect(() => {
    if (settingsSection) setSettingsSection(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
      {/* Settings nav */}
      <nav className="w-full md:w-44 border-b md:border-b-0 md:border-r border-[var(--border)] bg-[var(--surface)] py-2 md:py-4 flex-shrink-0 flex md:flex-col overflow-y-hidden overflow-x-auto md:overflow-x-visible scrollbar-none">
        {[
          { id: "general" as const, label: "General", icon: Settings },
          { id: "ai" as const, label: "AI & Chat", icon: Bot },
          { id: "embeddings" as const, label: "Embeddings", icon: Network },
          { id: "agents" as const, label: "Coding Agents", icon: Terminal },
          { id: "tools" as const, label: "Tools", icon: Wrench },
          { id: "mobile" as const, label: "Mobile Access", icon: Smartphone },
          { id: "sync" as const, label: "Device Sync", icon: FolderSync },
          { id: "tags" as const, label: "Tags", icon: Tag },
          { id: "shortcuts" as const, label: "Shortcuts", icon: Keyboard },
          { id: "data" as const, label: "Data", icon: Database },
          { id: "about" as const, label: "About", icon: Info },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setSection(id)}
            className={cn(
              "flex items-center gap-2.5 px-4 py-2 text-xs transition-colors text-left border-b-2 md:border-b-0 md:border-l-2 border-l-0 shrink-0 whitespace-nowrap",
              section === id
                ? "text-[var(--text-primary)] bg-[var(--surface-2)] border-[var(--accent)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] border-transparent"
            )}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Shared header */}
        <div className="flex items-center gap-4 px-4 md:px-8 pt-4 md:pt-8 pb-4 md:pb-6 border-b border-[var(--border-subtle)]">
          <img src="/icon.png" alt="Cairn" className="w-9 h-9 object-contain flex-shrink-0" />
          <div>
            <div className="text-sm font-semibold text-[var(--text-primary)]">Cairn</div>
            <div className="text-xs text-[var(--text-tertiary)]">v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0"}</div>
          </div>
        </div>
        <div key={section} className="@container max-w-2xl mx-auto px-4 md:px-8 py-4 md:py-8 space-y-6 md:space-y-8 animate-fade-in">
          {section === "general" && <GeneralSettings />}
          {section === "ai" && <AISettings />}
          {section === "embeddings" && <EmbeddingsSettings />}
          {section === "agents" && <AgentSettings />}
          {section === "tools" && <ToolsSettings />}
          {section === "mobile" && <MobileSettings />}
          {section === "sync" && <SyncSettings />}
          {section === "tags" && <TagsSettings />}
          {section === "shortcuts" && <ShortcutsSettings />}
          {section === "data" && (
            <DataSettings
              stats={{
                workspaces: workspaces.length,
                projects: projects.length,
                notes: notes.length,
                cards: cards.length,
              }}
            />
          )}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}
