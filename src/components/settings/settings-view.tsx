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
  SlashSquare,
  PenLine,
  Puzzle,
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
import { CommandsSettings } from "./CommandsSettings";
import { UserStyleSettings } from "./UserStyleSettings";
import { PluginsSettings } from "./PluginsSettings";
import type { SettingsSection } from "@/types";

export function SettingsView() {
  const { workspaces, projects, notes, cards, settingsSection, setSettingsSection } = useCairnStore(useShallow((s) => ({ workspaces: s.workspaces, projects: s.projects, notes: s.notes, cards: s.cards, settingsSection: s.settingsSection, setSettingsSection: s.setSettingsSection })));

  // Map legacy section ids to new consolidated parents (so deep-links keep working).
  // general now holds Tags; ai holds agents; extensions holds tools/commands/plugins; system holds shortcuts/data/about.
  function mapLegacySection(s: SettingsSection | null): SettingsSection {
    if (!s) return "general";
    if (s === "tags") return "general";
    if (s === "agents") return "ai";
    if (s === "tools" || s === "commands" || s === "plugins") return "extensions";
    if (s === "shortcuts" || s === "data" || s === "about") return "system";
    return s;
  }
  function initialSystemSubtab(s: SettingsSection | null): "shortcuts" | "data" | "about" {
    if (s === "data") return "data";
    if (s === "about") return "about";
    return "shortcuts";
  }
  function initialExtensionsSubtab(s: SettingsSection | null): "tools" | "commands" | "plugins" {
    if (s === "commands") return "commands";
    if (s === "plugins") return "plugins";
    return "tools";
  }

  // Honour a requested target section (e.g. "open Tools" from the Overview) as
  // the initial section, then clear the request so it doesn't override manual
  // navigation later. Consumed once at mount.
  const [section, setSection] = useState<SettingsSection>(
    () => mapLegacySection(settingsSection ?? "general"),
  );
  const [aiSubtab, setAiSubtab] = useState<"chat" | "agents">(
    () => (settingsSection === "agents" ? "agents" : "chat"),
  );
  const [extensionsSubtab, setExtensionsSubtab] = useState<"tools" | "commands" | "plugins">(
    () => initialExtensionsSubtab(settingsSection as SettingsSection | null),
  );
  const [systemSubtab, setSystemSubtab] = useState<"shortcuts" | "data" | "about">(
    () => initialSystemSubtab(settingsSection as SettingsSection | null),
  );
  React.useEffect(() => {
    if (settingsSection) {
      // Sync subtab when deep-link arrives
      if (settingsSection === "agents") setAiSubtab("agents");
      if (settingsSection === "ai") setAiSubtab("chat");
      if (settingsSection === "tools" || settingsSection === "commands" || settingsSection === "plugins") {
        setExtensionsSubtab(initialExtensionsSubtab(settingsSection));
      }
      if (settingsSection === "shortcuts" || settingsSection === "data" || settingsSection === "about") {
        setSystemSubtab(initialSystemSubtab(settingsSection));
      }
      setSection(mapLegacySection(settingsSection));
      setSettingsSection(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
      {/* Settings nav — 8 entries (was 14). General holds Tags; AI holds Agents; Extensions holds Tools/Commands/Plugins; System holds Shortcuts/Data/About. */}
      <nav className="w-full md:w-44 border-b md:border-b-0 md:border-r border-[var(--border)] bg-[var(--surface)] py-2 md:py-4 flex-shrink-0 flex md:flex-col overflow-y-hidden overflow-x-auto md:overflow-x-visible scrollbar-none">
        {[
          { id: "general" as const, label: "General", icon: Settings },
          { id: "ai" as const, label: "AI", icon: Bot },
          { id: "extensions" as const, label: "Extensions", icon: Puzzle },
          { id: "embeddings" as const, label: "Embeddings", icon: Network },
          { id: "writing-style" as const, label: "Writing Style", icon: PenLine },
          { id: "mobile" as const, label: "Mobile Access", icon: Smartphone },
          { id: "sync" as const, label: "Device Sync", icon: FolderSync },
          { id: "system" as const, label: "System", icon: Info },
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
          {section === "general" && (
            <div className="space-y-8">
              <GeneralSettings />
              <div className="border-t border-[var(--border-subtle)] pt-8">
                <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2"><Tag size={14} /> Tags</h3>
                <TagsSettings />
              </div>
            </div>
          )}
          {section === "ai" && (
            <div className="space-y-6">
              <div className="flex gap-1 p-1 bg-[var(--surface-2)] rounded-lg w-fit">
                <button onClick={() => setAiSubtab("chat")} className={cn("px-3 py-1.5 text-xs font-medium rounded-md transition-colors", aiSubtab === "chat" ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}>Chat</button>
                <button onClick={() => setAiSubtab("agents")} className={cn("px-3 py-1.5 text-xs font-medium rounded-md transition-colors", aiSubtab === "agents" ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}>Coding Agents</button>
              </div>
              {aiSubtab === "chat" ? <AISettings /> : <AgentSettings />}
            </div>
          )}
          {section === "embeddings" && <EmbeddingsSettings />}
          {section === "extensions" && (
            <div className="space-y-6">
              <div className="flex gap-1 p-1 bg-[var(--surface-2)] rounded-lg w-fit">
                <button onClick={() => setExtensionsSubtab("tools")} className={cn("px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5", extensionsSubtab === "tools" ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><Wrench size={12} /> Tools</button>
                <button onClick={() => setExtensionsSubtab("commands")} className={cn("px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5", extensionsSubtab === "commands" ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><SlashSquare size={12} /> Commands</button>
                <button onClick={() => setExtensionsSubtab("plugins")} className={cn("px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5", extensionsSubtab === "plugins" ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><Puzzle size={12} /> Plugins</button>
              </div>
              {extensionsSubtab === "tools" && <ToolsSettings />}
              {extensionsSubtab === "commands" && <CommandsSettings />}
              {extensionsSubtab === "plugins" && <PluginsSettings />}
            </div>
          )}
          {section === "writing-style" && <UserStyleSettings />}
          {section === "mobile" && <MobileSettings />}
          {section === "sync" && <SyncSettings />}
          {section === "system" && (
            <div className="space-y-6">
              <div className="flex gap-1 p-1 bg-[var(--surface-2)] rounded-lg w-fit">
                <button onClick={() => setSystemSubtab("shortcuts")} className={cn("px-3 py-1.5 text-xs font-medium rounded-md transition-colors", systemSubtab === "shortcuts" ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}>Shortcuts</button>
                <button onClick={() => setSystemSubtab("data")} className={cn("px-3 py-1.5 text-xs font-medium rounded-md transition-colors", systemSubtab === "data" ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}>Data</button>
                <button onClick={() => setSystemSubtab("about")} className={cn("px-3 py-1.5 text-xs font-medium rounded-md transition-colors", systemSubtab === "about" ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}>About</button>
              </div>
              {systemSubtab === "shortcuts" && <ShortcutsSettings />}
              {systemSubtab === "data" && (
                <DataSettings
                  stats={{
                    workspaces: workspaces.length,
                    projects: projects.length,
                    notes: notes.length,
                    cards: cards.length,
                  }}
                />
              )}
              {systemSubtab === "about" && <AboutSection />}
            </div>
          )}
          {/* Legacy deep-links still work — render the same grouped parents */}
          {section === "agents" && <AgentSettings />}
          {section === "tools" && <ToolsSettings />}
          {section === "commands" && <CommandsSettings />}
          {section === "plugins" && <PluginsSettings />}
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
