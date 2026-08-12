"use client";

import { useState, useEffect } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { ipcAwaitResult } from "@/store/ipc";
import { DEFAULT_WORKSPACE_ICON, DEFAULT_PROJECT_ICON } from "@/lib/workspace-icons";
import type { OnboardingStep } from "./shared";
import { StepChooseFolder } from "./StepChooseFolder";
import { StepWorkspaceDetails } from "./StepWorkspaceDetails";
import { StepAppearance } from "./StepAppearance";
import { StepAISetup } from "./StepAISetup";
import { StepProviders } from "./StepProviders";
import { StepMCP } from "./StepMCP";
import { StepEmbeddings } from "./StepEmbeddings";
import { StepViews } from "./StepViews";
import { StepCreateProject } from "./StepCreateProject";
import { StepImportedProjects, type ImportedProject } from "./StepImportedProjects";
import { StepDone } from "./StepDone";
import type { ToggleableView } from "@/store/slices/ui";

type ImportPreview = Awaited<ReturnType<NonNullable<typeof window.electron>["probeWorkspaceFolder"]>>;

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  onComplete: (startTour: boolean) => void;
  /** Where to enter the wizard. Defaults to "choose-folder". */
  initialStep?: OnboardingStep;
}

// ── Onboarding wizard ─────────────────────────────────────────────────────────

export function Onboarding({ onComplete, initialStep = "choose-folder" }: Props) {
  const { createWorkspace, initWorkspacePath, getWorkspacePath, theme, setTheme, fontScale, setFontScale, aiConfig, setAIConfig, setAgentConfig, hiddenViews, setHiddenViews, createProject, setActiveProject, activeWorkspaceId } = useCairnStore(useShallow((s) => ({ createWorkspace: s.createWorkspace, initWorkspacePath: s.initWorkspacePath, getWorkspacePath: s.getWorkspacePath, theme: s.theme, setTheme: s.setTheme, fontScale: s.fontScale, setFontScale: s.setFontScale, aiConfig: s.aiConfig, setAIConfig: s.setAIConfig, setAgentConfig: s.setAgentConfig, hiddenViews: s.hiddenViews, setHiddenViews: s.setHiddenViews, createProject: s.createProject, setActiveProject: s.setActiveProject, activeWorkspaceId: s.activeWorkspaceId })));

  // ── Wizard step ──────────────────────────────────────────────────────────────
  const [step, setStep] = useState<OnboardingStep>(initialStep);

  // ── Workspace ────────────────────────────────────────────────────────────────
  const [chosenFolder, setChosenFolder] = useState<string | null>(null);
  const [wsName, setWsName] = useState("");
  const [wsIcon, setWsIcon] = useState(DEFAULT_WORKSPACE_ICON);
  const [submitting, setSubmitting] = useState(false);
  // Vault detection (populated by probing the chosen folder).
  const [isObsidianVault, setIsObsidianVault] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [excludedFolders, setExcludedFolders] = useState<Set<string>>(new Set());
  // Projects auto-created from the vault by the post-workspace rescan. When
  // non-empty we show a "found these projects" summary instead of prompting the
  // user to create their first project.
  const [importedProjects, setImportedProjects] = useState<ImportedProject[]>([]);
  // Visible on the imported-projects summary when a rollback/undo fails.
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  // ── View visibility (local copy; committed when user hits Next on StepViews) ─
  const [localHidden, setLocalHidden] = useState<Set<ToggleableView>>(new Set(hiddenViews));

  function toggleLocalView(view: ToggleableView) {
    setLocalHidden((prev) => {
      const next = new Set(prev);
      if (next.has(view)) { next.delete(view); } else { next.add(view); }
      return next;
    });
  }

  // ── First project ───────────────────────────────────────────────────────────
  const [projectName, setProjectName] = useState("");
  const [projectIcon, setProjectIcon] = useState(DEFAULT_PROJECT_ICON);
  const [creatingProject, setCreatingProject] = useState(false);

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = projectName.trim();
    if (!trimmed || creatingProject || !activeWorkspaceId) return;
    setCreatingProject(true);
    try {
      const proj = await createProject(activeWorkspaceId, trimmed, projectIcon);
      setActiveProject(proj.id);
      setStep("done");
    } finally {
      setCreatingProject(false);
    }
  }

  // ── AI ───────────────────────────────────────────────────────────────────────
  const [aiEnabled, setAiEnabled] = useState(aiConfig.aiEnabled ?? true);
  const [provider, setProvider]   = useState<string>(aiConfig.provider ?? "openai");
  const [baseUrl, setBaseUrl]     = useState(aiConfig.baseUrl || "https://api.openai.com");
  const [apiKey, setApiKey]       = useState(aiConfig.apiKey || "");
  const [model, setModel]         = useState(aiConfig.model || "gpt-5.6-luna");

  // ── Embeddings ───────────────────────────────────────────────────────────────
  const [embEnabled, setEmbEnabled] = useState(false);
  const [embModelId, setEmbModelId] = useState("Xenova/bge-small-en-v1.5");

  // Pre-populate folder path when skipping the folder-picker step
  useEffect(() => {
    if (initialStep !== "choose-folder") {
      getWorkspacePath().then((p) => {
        if (!p) return;
        setChosenFolder(p);
        void loadImportPreview(p);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialStep]);

  // Hydrate embeddings settings if a previous session saved them
  useEffect(() => {
    const e = window.electron?.embeddings;
    if (!e?.getSettings) return;
    e.getSettings().then((s) => {
      if (!s) return;
      if (typeof s.enabled === "boolean") setEmbEnabled(s.enabled);
      if (typeof s.modelId === "string" && s.modelId) setEmbModelId(s.modelId);
    }).catch(() => {});
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  async function loadImportPreview(folder: string) {
    setPreviewReady(false);
    setImportPreview(null);
    try {
      const probe = await window.electron?.probeWorkspaceFolder?.(folder);
      if (!probe) throw new Error("Folder preview unavailable");
      setIsObsidianVault(!!probe.isObsidianVault);
      setImportPreview(probe);
      setExcludedFolders(new Set(probe.excludedFolders ?? []));
      setPreviewReady(true);
    } catch {
      setIsObsidianVault(false);
      setPreviewReady(false);
    }
  }

  async function handleChooseFolder() {
    setSubmitting(true);
    try {
      const folder = await window.electron?.selectWorkspaceFolder?.();
      if (!folder) return;
      setChosenFolder(folder);
      await loadImportPreview(folder);
      setStep("workspace-details");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreateWorkspace(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = wsName.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      // Only write the workspace path if the folder was chosen fresh this session
      // (i.e. we started at choose-folder and the user picked a new folder)
      if (chosenFolder && initialStep === "choose-folder") {
        await initWorkspacePath(chosenFolder, [...excludedFolders]);
      }
      const ws = await createWorkspace(trimmed, wsIcon);
      // The workspace record now exists. Re-scan the chosen folder so any
      // existing Obsidian vault folders (or loose root .md files) are turned
      // into projects + notes, attached to the workspace we just created. The
      // initial scan in initWorkspace ran before the workspace existed, so it
      // couldn't auto-create projects. Capture the created projects so a later
      // step can show them instead of prompting to create one.
      try {
        const result = await ipcAwaitResult<{ projectsCreated: number; createdProjects: ImportedProject[] }>(
          (e) => e.rescanWorkspace(ws.id, [...excludedFolders]) as unknown as Promise<{ data: { projectsCreated: number; createdProjects: ImportedProject[] } } | { error: string }>,
        );
        setImportedProjects("data" in result ? result.data.createdProjects : []);
      } catch {
        // Best-effort — onboarding shouldn't block on the rescan.
        setImportedProjects([]);
      }
      setStep("appearance");
    } finally {
      setSubmitting(false);
    }
  }

  /** Undo the import: remove the created projects/notes, strip Cairn frontmatter
   *  from the vault files, and stop managing the folder — then let the user pick
   *  a different folder. Best-effort; a failure stays on the summary and is
   *  reported there. Guarded against concurrent clicks via `submitting`. */
  async function handleRollbackImport() {
    const ids = importedProjects.map((p) => p.id);
    if (ids.length === 0 || submitting) return;
    setSubmitting(true);
    setRollbackError(null);
    try {
      await window.electron?.rollbackImport(ids);
      // Reset the wizard state so a fresh choose-folder → create-workspace flow
      // starts clean — no stale folder/name/icon or imported-project leftovers.
      setImportedProjects([]);
      setChosenFolder(null);
      setWsName("");
      setWsIcon(DEFAULT_WORKSPACE_ICON);
      setStep("choose-folder");
    } catch (err) {
      console.error("[onboarding] rollback import failed:", err);
      setRollbackError("Rollback failed — the imported projects were not removed. You can retry the undo or continue with them.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleSaveAI() {
    setAIConfig({ aiEnabled, provider: provider as "openai" | "localllm", baseUrl, apiKey, model });
    if (provider !== "localllm") {
      setAgentConfig({ baseUrl, apiKey, model });
    }
    setStep("providers");
  }

  async function handleSaveEmbeddings() {
    const e = window.electron?.embeddings;
    const rt = window.electron?.runtime;
    if (e?.saveSettings) {
      try {
        await e.saveSettings({ enabled: embEnabled, modelId: embModelId });
        if (embEnabled && rt?.embeddings.setDefault) {
          await rt.embeddings.setDefault(embModelId);
        }
      } catch {
        // Best-effort — wizard shouldn't block on this
      }
    }
    setStep("views");
  }

  // ── Routing ───────────────────────────────────────────────────────────────────

  if (step === "choose-folder") {
    return (
      <StepChooseFolder
        chosenFolder={chosenFolder}
        submitting={submitting}
        onChoose={handleChooseFolder}
      />
    );
  }

  if (step === "workspace-details") {
    return (
      <StepWorkspaceDetails
        chosenFolder={chosenFolder}
        name={wsName}
        icon={wsIcon}
        submitting={submitting}
        showBack={step === "workspace-details" && initialStep === "choose-folder"}
        isObsidianVault={isObsidianVault}
        importPreview={importPreview}
        previewReady={previewReady}
        excludedFolders={excludedFolders}
        onBack={() => setStep("choose-folder")}
        onNameChange={setWsName}
        onIconChange={setWsIcon}
        onToggleExcludedFolder={(folder) => setExcludedFolders((current) => {
          const next = new Set(current);
          if (next.has(folder)) next.delete(folder); else next.add(folder);
          return next;
        })}
        onRetryPreview={() => chosenFolder && void loadImportPreview(chosenFolder)}
        onSubmit={handleCreateWorkspace}
      />
    );
  }

  if (step === "appearance") {
    return (
      <StepAppearance
        theme={theme}
        fontScale={fontScale}
        onThemeChange={setTheme}
        onFontScaleChange={setFontScale}
        onNext={() => setStep("ai-setup")}
      />
    );
  }

  if (step === "ai-setup") {
    return (
      <StepAISetup
        aiEnabled={aiEnabled}
        provider={provider}
        baseUrl={baseUrl}
        apiKey={apiKey}
        model={model}
        onAiEnabledChange={setAiEnabled}
        onProviderChange={setProvider}
        onBaseUrlChange={setBaseUrl}
        onApiKeyChange={setApiKey}
        onModelChange={setModel}
        onBack={() => setStep("appearance")}
        onNext={handleSaveAI}
      />
    );
  }

  if (step === "providers") {
    return (
      <StepProviders
        onBack={() => setStep("ai-setup")}
        onNext={() => setStep("mcp")}
      />
    );
  }

  if (step === "mcp") {
    return (
      <StepMCP
        onBack={() => setStep("providers")}
        onNext={() => setStep("embeddings")}
      />
    );
  }

  if (step === "embeddings") {
    return (
      <StepEmbeddings
        enabled={embEnabled}
        modelId={embModelId}
        onEnabledChange={setEmbEnabled}
        onModelIdChange={setEmbModelId}
        onBack={() => setStep("mcp")}
        onNext={handleSaveEmbeddings}
      />
    );
  }

  if (step === "views") {
    return (
      <StepViews
        hidden={localHidden}
        onToggle={toggleLocalView}
        onBack={() => setStep("embeddings")}
        onNext={() => {
          setHiddenViews([...localHidden]);
          // If the vault scan already created projects, show a summary of them
          // instead of prompting the user to create their first project.
          setStep(importedProjects.length > 0 ? "imported-projects" : "create-project");
        }}
      />
    );
  }

  if (step === "create-project") {
    return (
      <StepCreateProject
        name={projectName}
        icon={projectIcon}
        submitting={creatingProject}
        onBack={() => setStep("views")}
        onNameChange={setProjectName}
        onIconChange={setProjectIcon}
        onSubmit={handleCreateProject}
        onSkip={() => setStep("done")}
      />
    );
  }

  if (step === "imported-projects") {
    return (
      <StepImportedProjects
        projects={importedProjects}
        busy={submitting}
        error={rollbackError}
        onBack={() => setStep("views")}
        onContinue={() => setStep("done")}
        onUndo={handleRollbackImport}
      />
    );
  }

  // step === "done"
  return (
    <StepDone
      onBack={() => setStep(importedProjects.length > 0 ? "imported-projects" : "create-project")}
      onComplete={onComplete}
    />
  );
}
