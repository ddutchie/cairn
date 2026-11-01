"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "@/components/ui/button";
import { GeneralSettings } from "./GeneralSettings";
import { ViewVisibilitySettings } from "./ViewVisibilitySettings";
import { AISettings } from "./AISettings";
import { ModelsSettings } from "./ModelsSettings";
import { TagsSettings } from "./TagsSettings";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { DataSettings } from "./DataSettings";
import { AboutSection } from "./AboutSection";
import { AgentSettings } from "./AgentSettings";
import { McpSettingsTab } from "./MCPSettings";
import { SyncSettings } from "./SyncSettings";
import { EmbeddingsSettings } from "./EmbeddingsSettings";
import { ToolsSettings } from "./ToolsSettings";
import { CommandsSettings } from "./CommandsSettings";
import { UserStyleSettings } from "./UserStyleSettings";
import {
  SETTINGS_NAV,
  SETTINGS_PAGES,
  resolveSettingsPage,
  searchSettings,
  type SettingsPage,
} from "./settings-index";
import { IconButton } from "@/components/ui/icon-button";

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0";

/**
 * Settings: one grouped rail (no subtabs), one page per task, and a search
 * box that jumps to a specific row. Deep links (`setSettingsSection`) work at
 * mount and while Settings is already open; old tab ids still resolve.
 */
export function SettingsView() {
  const { workspaces, projects, notes, cards, settingsSection, setSettingsSection } = useCairnStore(useShallow((s) => ({
    workspaces: s.workspaces,
    projects: s.projects,
    notes: s.notes,
    cards: s.cards,
    settingsSection: s.settingsSection,
    setSettingsSection: s.setSettingsSection,
  })));

  const [page, setPage] = useState<SettingsPage>(() => resolveSettingsPage(settingsSection));
  const [query, setQuery] = useState("");
  // Row label to scroll to and flash once the target page has rendered.
  const [pendingRow, setPendingRow] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Consume a deep-link request, whether it arrived before or after mount.
  useEffect(() => {
    if (!settingsSection) return;
    queueMicrotask(() => {
      setPage(resolveSettingsPage(settingsSection));
      setSettingsSection(null);
    });
  }, [settingsSection, setSettingsSection]);

  // New page: start at the top (unless a search result is about to scroll).
  useEffect(() => {
    if (!pendingRow) contentRef.current?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    if (!pendingRow) return;
    const frame = requestAnimationFrame(() => {
      const row = contentRef.current?.querySelector<HTMLElement>(`[data-settings-label="${CSS.escape(pendingRow)}"]`);
      setPendingRow(null);
      if (!row) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      row.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
      row.setAttribute("data-settings-flash", "");
      window.setTimeout(() => row.removeAttribute("data-settings-flash"), 1600);
      row.querySelector<HTMLElement>("input, select, textarea, button, [tabindex='0']")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [page, pendingRow]);

  const results = useMemo(() => searchSettings(query), [query]);
  const current = SETTINGS_PAGES.find((p) => p.id === page) ?? SETTINGS_PAGES[0];

  function goTo(next: SettingsPage, row?: string) {
    setPage(next);
    setPendingRow(row ?? null);
    if (row) setQuery("");
  }

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
      <nav aria-label="Settings" className="w-full md:w-56 border-b md:border-b-0 md:border-r border-[var(--border)] bg-[var(--surface)] flex-shrink-0 flex flex-col min-h-0">
        <div className="p-3 md:pb-2">
          <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 focus-within:border-[var(--accent)]">
            <Search size={12} className="flex-shrink-0 text-[var(--text-tertiary)]" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && results[0]) goTo(results[0].page, results[0].label);
                if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); }
              }}
              placeholder="Search settings"
              aria-label="Search settings"
              aria-controls="settings-search-results"
              className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <IconButton label="Clear search" onClick={() => { setQuery(""); searchRef.current?.focus(); }} className="size-auto p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                <X size={11} />
              </IconButton>
            )}
          </div>
        </div>

        {query ? (
          <div id="settings-search-results" role="region" aria-label="Search results" aria-live="polite" className="flex-1 overflow-y-auto px-2 pb-3 max-h-64 md:max-h-none">
            {results.length === 0 ? (
              <p className="px-2 py-3 text-xs text-[var(--text-tertiary)]">No settings match &ldquo;{query}&rdquo;.</p>
            ) : (
              <ul className="space-y-0.5">
                {results.map((r) => (
                  <li key={`${r.page}:${r.label}`}>
                    <button
                      type="button"
                      onClick={() => goTo(r.page, r.label)}
                      className={cn("w-full rounded-md px-2.5 py-1.5 text-left hover:bg-[var(--surface-2)]", FOCUS_RING)}
                    >
                      <span className="block truncate text-xs text-[var(--text-primary)]">{r.label}</span>
                      <span className="block truncate text-2xs text-[var(--text-tertiary)]">{r.pageLabel}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex md:block overflow-x-auto md:overflow-x-visible md:overflow-y-auto md:flex-1 px-2 pb-2 md:pb-4 gap-1 scrollbar-none">
            {SETTINGS_NAV.map(({ group, items }) => (
              <div key={group} role="group" aria-label={group} className="flex md:block gap-1 md:mb-3 shrink-0">
                <div className="hidden md:block px-2.5 pt-2 pb-1 text-xs font-medium text-[var(--text-tertiary)]">{group}</div>
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={page === item.id ? "page" : undefined}
                    onClick={() => goTo(item.id)}
                    className={cn(
                      "flex w-full items-center rounded-md px-2.5 py-1.5 text-xs text-left whitespace-nowrap transition-colors",
                      FOCUS_RING,
                      page === item.id
                        ? "bg-[var(--accent-dim)] text-[var(--accent)] font-medium"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </nav>

      <div ref={contentRef} className="flex-1 overflow-y-auto">
        <section
          key={page}
          id="settings-panel"
          aria-labelledby="settings-title"
          className="@container max-w-3xl px-4 md:px-10 py-6 md:py-8 space-y-8 animate-fade-in"
        >
          <header>
            <h1 id="settings-title" className="text-lg font-semibold text-[var(--text-primary)]">{current.label}</h1>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              {page === "about" ? `Cairn ${APP_VERSION}` : current.description}
            </p>
          </header>
          {page === "general" && <GeneralSettings />}
          {page === "views" && <ViewVisibilitySettings />}
          {page === "tags" && <TagsSettings />}
          {page === "shortcuts" && <ShortcutsSettings />}
          {page === "models" && <ModelsSettings />}
          {page === "ai" && <AISettings />}
          {page === "agents" && <AgentSettings />}
          {page === "writing-style" && <UserStyleSettings />}
          {page === "embeddings" && <EmbeddingsSettings />}
          {page === "tools" && <ToolsSettings />}
          {page === "commands" && <CommandsSettings />}
          {page === "mcp" && <McpSettingsTab />}
          {page === "sync" && <SyncSettings />}
          {page === "data" && (
            <DataSettings stats={{ workspaces: workspaces.length, projects: projects.length, notes: notes.length, cards: cards.length }} />
          )}
          {page === "about" && <AboutSection />}
        </section>
      </div>
    </div>
  );
}
