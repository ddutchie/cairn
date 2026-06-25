"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { SettingsGroup, SettingsRow } from "./shared";
import { Button } from "@/components/ui/button";
import type { ProjectSettings } from "@/types";

export function ProjectSettingsSection() {
  const { projects, activeProjectId, updateProject } = useCairnStore(useShallow((s) => ({
    projects: s.projects,
    activeProjectId: s.activeProjectId,
    updateProject: s.updateProject,
  })));

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;

  const [settings, setSettings] = useState<ProjectSettings>(
    (activeProject?.projectSettings as ProjectSettings) ?? {}
  );
  const [saving, setSaving] = useState(false);

  if (!activeProject) {
    return (
      <div className="text-xs text-[var(--text-tertiary)] py-8 text-center">
        No project selected. Create or select a project to configure its settings.
      </div>
    );
  }

  function update(field: keyof ProjectSettings, value: string | boolean | undefined) {
    setSettings((prev) => ({ ...prev, [field]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      await window.electron?.project.updateSettings(activeProject.id, settings);
      updateProject(activeProject.id, { projectSettings: settings as unknown as Record<string, unknown> });
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    const cleared: ProjectSettings = {};
    setSettings(cleared);
  }

  const hasChanges = JSON.stringify(settings) !== JSON.stringify(activeProject?.projectSettings ?? {});

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Project Settings</h2>
        <p className="text-xs text-[var(--text-tertiary)]">
          Configure per-project settings for {activeProject.name} — PR templates, git defaults, and more.
        </p>
      </div>

      <SettingsGroup title="Git & PR" description="Settings for commit messages, PR descriptions, and git workflow.">
        {/* PR template */}
        <div>
          <label className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] block mb-1.5">
            PR Description Template
          </label>
          <textarea
            value={settings.prTemplate ?? ""}
            onChange={(e) => update("prTemplate", e.target.value || undefined)}
            placeholder={`Paste a PR template or leave blank to use .github/PULL_REQUEST_TEMPLATE.md\n\nExample:\n## Summary\n\n## Changes\n\n## Testing`}
            rows={6}
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 font-mono focus:outline-none resize-y"
          />
          <p className="mt-1 text-[0.714rem] text-[var(--text-tertiary)]">
            When set, this template is used for AI-generated PR descriptions. Overrides any
            <code className="font-mono text-[var(--accent)] mx-1">.github/PULL_REQUEST_TEMPLATE.md</code>
            in the repository.
          </p>
        </div>

        {/* Default branch */}
        <SettingsRow label="Default branch" description="Target branch for PRs (e.g. main, develop).">
          <input
            value={settings.defaultBranch ?? ""}
            onChange={(e) => update("defaultBranch", e.target.value || undefined)}
            placeholder="main"
            className="w-40 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 font-mono focus:outline-none"
          />
        </SettingsRow>

        {/* Auto-stage on commit */}
        <SettingsRow
          label="Auto-stage on commit"
          description="When enabled, the Git tab will stage all changes before committing (git add -A)."
        >
          <input
            id="autoStageOnCommit"
            type="checkbox"
            checked={settings.autoStageOnCommit ?? false}
            onChange={(e) => update("autoStageOnCommit", e.target.checked || undefined)}
            className="w-4 h-4 rounded border-[var(--border)] bg-[var(--surface-2)] text-[var(--accent)] accent-[var(--accent)] cursor-pointer"
          />
        </SettingsRow>
      </SettingsGroup>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2 border-t border-[var(--border-subtle)]">
        <Button variant="ghost" size="sm" onClick={reset} disabled={!hasChanges}>
          <RotateCcw size={11} />
          Reset to defaults
        </Button>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <span className="text-[0.714rem] text-[var(--text-tertiary)]">Unsaved changes</span>
          )}
          <Button size="sm" onClick={save} disabled={!hasChanges || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
