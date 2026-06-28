"use client";

import React, { useState, useEffect } from "react";
import licensesData from "@/generated/licenses.json";
import { SettingsGroup } from "./shared";
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";
import { NewFeatureModal } from "@/components/layout/NewFeatureModal";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Play, Sparkles } from "lucide-react";

export function AboutSection() {
  const [licensesOpen, setLicensesOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(true);
  const [changelog, setChangelog] = useState<string | null>(null);
  const [forceNewFeatures, setForceNewFeatures] = useState(false);

  const { setTutorialActive, setView } = useCairnStore(
    useShallow((s) => ({
      setTutorialActive: s.setTutorialActive,
      setView: s.setView,
    }))
  );

  const handleStartTutorial = () => {
    setView("overview");
    setTutorialActive(true);
  };
  const { stackByCategory, allLicenses } = licensesData as typeof licensesData & {
    stackByCategory: { category: string; entries: typeof licensesData.stack }[];
  };

  useEffect(() => {
    if (typeof window !== "undefined" && window.electron?.latestChangelog) {
      window.electron.latestChangelog().then((md) => setChangelog(md ?? null));
    }
  }, []);

  return (
    <SettingsGroup title="About Cairn">
      <div className="space-y-4 text-sm text-[var(--text-secondary)]">
        <p className="text-xs leading-relaxed text-[var(--text-tertiary)]">
          Local-first notes and kanban in one place. Notes are saved as Markdown files in a folder you choose; project and task data lives in SQLite alongside them. No accounts, no cloud. An embedded MCP server lets AI agents read and write your workspace directly.
        </p>

        {/* Interactive help controls */}
        <div className="grid grid-cols-2 gap-3 py-1">
          <button
            onClick={handleStartTutorial}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors cursor-pointer"
          >
            <Play size={13} className="text-[var(--accent)]" />
            <span>Replay App Tour</span>
          </button>
          <button
            onClick={() => setForceNewFeatures(true)}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors cursor-pointer"
          >
            <Sparkles size={13} className="text-[var(--accent)] animate-pulse" />
            <span>What&apos;s New</span>
          </button>
        </div>

        {forceNewFeatures && (
          <NewFeatureModal forceOpen={true} onClose={() => setForceNewFeatures(false)} />
        )}

        {/* Latest changelog */}
        {changelog && (
          <div className="rounded-lg border border-[var(--border)] overflow-hidden">
            <button
              onClick={() => setChangelogOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
            >
              <span>What&apos;s new</span>
              <span className="text-[var(--text-tertiary)]">{changelogOpen ? "▲" : "▼"}</span>
            </button>
            {changelogOpen && (
              <div className="border-t border-[var(--border)] max-h-96 overflow-y-auto">
                <NoteMarkdownPreview content={changelog} className="!py-3" />
              </div>
            )}
          </div>
        )}

        {/* Stack */}
        <div className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Stack</div>
          {stackByCategory.map(({ category, entries }) => (
            <div key={category} className="space-y-1.5">
              <div className="text-[0.714rem] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] opacity-60">{category}</div>
              <div className="grid grid-cols-2 gap-1.5">
                {entries.map((entry) => (
                  <div
                    key={entry.name}
                    className="flex items-center justify-between px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                  >
                    <div>
                      <span className="text-xs font-medium text-[var(--text-primary)]">{entry.label}</span>
                      <span className="text-[0.714rem] text-[var(--text-tertiary)] ml-1.5">{entry.version}</span>
                    </div>
                    <span className="text-[0.714rem] text-[var(--text-tertiary)]">{entry.role}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Licenses */}
        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          <button
            onClick={() => setLicensesOpen((o) => !o)}
            className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <span>Open Source Licenses ({allLicenses.length})</span>
            <span className="text-[var(--text-tertiary)]">{licensesOpen ? "▲" : "▼"}</span>
          </button>
          {licensesOpen && (
            <div className="border-t border-[var(--border)] divide-y divide-[var(--border-subtle)] max-h-72 overflow-y-auto">
              {allLicenses.map((entry) => (
                <div key={entry.name} className="flex items-center justify-between px-4 py-2">
                  <div>
                    <span className="text-[0.786rem] text-[var(--text-secondary)]">{entry.name}</span>
                    <span className="text-[0.714rem] text-[var(--text-tertiary)] ml-1.5">{entry.version}</span>
                  </div>
                  <span className="text-[0.714rem] font-mono text-[var(--text-tertiary)] bg-[var(--surface-2)] px-1.5 py-0.5 rounded">{entry.license}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </SettingsGroup>
  );
}
