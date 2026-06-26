"use client";

import { useState, useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { SettingsGroup, SettingsRow } from "./shared";
import { Button } from "@/components/ui/button";
import type { ProjectSettings } from "@/types";
import { cn } from "@/lib/utils";

interface ProjectSettingsSectionProps {
  showHeader?: boolean;
}

export function ProjectSettingsSection({ showHeader = true }: ProjectSettingsSectionProps) {
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
  const [repoTemplateExists, setRepoTemplateExists] = useState(false);

  useEffect(() => {
    const currentProjectId = activeProject?.id;
    if (activeProject?.codeDirectory && window.electron?.agent) {
      const pathSeparator = window.electron.platform === "win32" ? "\\" : "/";
      const templatePath = `${activeProject.codeDirectory}${pathSeparator}.github${pathSeparator}PULL_REQUEST_TEMPLATE.md`;
      window.electron.agent.readFile(templatePath)
        .then(() => {
          if (activeProject?.id === currentProjectId) {
            setRepoTemplateExists(true);
          }
        })
        .catch(() => {
          if (activeProject?.id === currentProjectId) {
            setRepoTemplateExists(false);
          }
        });
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRepoTemplateExists(false);
    }
  }, [activeProject]);

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
      const payload = {
        prTemplate: settings.prTemplate !== undefined ? settings.prTemplate : null,
        defaultBranch: settings.defaultBranch !== undefined ? settings.defaultBranch : null,
        autoStageOnCommit: settings.autoStageOnCommit !== undefined ? settings.autoStageOnCommit : null,
        useRepoPrTemplate: settings.useRepoPrTemplate !== undefined ? settings.useRepoPrTemplate : null,
      };
      await window.electron?.project.updateSettings(activeProject.id, payload);
      
      const cleanProjectSettings: ProjectSettings = {};
      if (payload.prTemplate !== null) cleanProjectSettings.prTemplate = payload.prTemplate;
      if (payload.defaultBranch !== null) cleanProjectSettings.defaultBranch = payload.defaultBranch;
      if (payload.autoStageOnCommit !== null) cleanProjectSettings.autoStageOnCommit = payload.autoStageOnCommit;
      if (payload.useRepoPrTemplate !== null) cleanProjectSettings.useRepoPrTemplate = payload.useRepoPrTemplate;

      updateProject(activeProject.id, { projectSettings: cleanProjectSettings as unknown as Record<string, unknown> });
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setSettings({
      prTemplate: undefined,
      defaultBranch: undefined,
      autoStageOnCommit: undefined,
      useRepoPrTemplate: undefined,
    });
  }

  const getNormalizedSettings = (s: ProjectSettings): ProjectSettings => {
    return {
      prTemplate: s.prTemplate || undefined,
      defaultBranch: s.defaultBranch || undefined,
      autoStageOnCommit: s.autoStageOnCommit !== undefined ? s.autoStageOnCommit : undefined,
      useRepoPrTemplate: s.useRepoPrTemplate !== undefined ? s.useRepoPrTemplate : undefined,
    };
  };

  const hasChanges = JSON.stringify(getNormalizedSettings(settings)) !== JSON.stringify(getNormalizedSettings((activeProject?.projectSettings as ProjectSettings) ?? {}));

  return (
    <div className="space-y-8">
      {showHeader && (
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Project Settings</h2>
          <p className="text-xs text-[var(--text-tertiary)]">
            Configure per-project settings for {activeProject.name} — PR templates, git defaults, and more.
          </p>
        </div>
      )}

      <SettingsGroup title="Git & PR" description="Settings for commit messages, PR descriptions, and git workflow.">
        
        {/* Repo PR template status indicator */}
        <div className="text-xs px-3.5 py-2.5 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            {repoTemplateExists ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
                <span className="text-[var(--text-secondary)]">
                  Discovered PR template in repository at <code className="font-mono text-[var(--accent)] bg-[var(--surface-3)] px-1 py-0.5 rounded">.github/PULL_REQUEST_TEMPLATE.md</code>
                </span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-tertiary)] opacity-40" />
                <span className="text-[var(--text-tertiary)]">
                  No PR template found in repository at <code className="font-mono text-[var(--text-tertiary)] bg-[var(--surface-3)] px-1 py-0.5 rounded">.github/PULL_REQUEST_TEMPLATE.md</code>
                </span>
              </>
            )}
          </div>
        </div>

        {/* Toggle to use repo template */}
        <SettingsRow
          label="Use repository PR template"
          description="Prefer the discovered repository-level template over the custom template."
        >
          <input
            type="checkbox"
            checked={settings.useRepoPrTemplate ?? false}
            disabled={!repoTemplateExists}
            onChange={(e) => {
              update("useRepoPrTemplate", e.target.checked);
            }}
            className="w-4 h-4 rounded border-[var(--border)] bg-[var(--surface-2)] text-[var(--accent)] accent-[var(--accent)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </SettingsRow>

        {/* PR template custom box */}
        <div className={cn("space-y-1.5 transition-opacity duration-200", settings.useRepoPrTemplate && "opacity-40 pointer-events-none")}>
          <label className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] block">
            Custom PR Description Template
          </label>
          <textarea
            value={settings.prTemplate ?? ""}
            disabled={settings.useRepoPrTemplate}
            onChange={(e) => update("prTemplate", e.target.value || undefined)}
            placeholder={`Paste a PR template or leave blank to use default layout\n\nExample:\n## Summary\n\n## Changes\n\n## Testing`}
            rows={6}
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 font-mono focus:outline-none resize-y disabled:bg-[var(--surface-2)] disabled:cursor-not-allowed"
          />
          <p className="text-[0.714rem] text-[var(--text-tertiary)]">
            When set, this template is used for AI-generated PR descriptions.
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
            onChange={(e) => update("autoStageOnCommit", e.target.checked)}
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
