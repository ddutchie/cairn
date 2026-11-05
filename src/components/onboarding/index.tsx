"use client";

import { useState, useEffect } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { ipcResult } from "@/store/ipc";
import { DEFAULT_WORKSPACE_ICON, DEFAULT_PROJECT_ICON } from "@/lib/workspace-icons";
import { markOnboardingInProgress } from "@/lib/onboarding-progress";
import type { OnboardingStep } from "./shared";
import { StepChooseFolder } from "./StepChooseFolder";
import { StepWorkspaceDetails } from "./StepWorkspaceDetails";
import { StepWelcome } from "./StepWelcome";
import { StepAppearance } from "./StepAppearance";
import { StepCreateProject } from "./StepCreateProject";
import { StepImportedProjects, type ImportedProject } from "./StepImportedProjects";
import { StepDone } from "./StepDone";

type ImportPreview = Awaited<ReturnType<NonNullable<typeof window.electron>["probeWorkspaceFolder"]>>;

/** Seed content for the starter project, so the board, notes and tour have
 *  something to show on a fresh install. */
const STARTER_NOTE = `# Welcome to Cairn

Notes are plain Markdown files saved on your disk. Write here, or ask the AI chat (⌘/) to edit them for you.

- Create more notes from the sidebar.
- Tasks live on the Board. Drag this project's cards between columns.
`;

const NO_WORKSPACE_MESSAGE = "No workspace is open yet. Restart Cairn and pick your folder again.";

function projectErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : "";
  return detail ? `Couldn't create the project: ${detail}` : "Couldn't create the project. Try again.";
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  onComplete: (startTour: boolean) => void;
  /** Where to enter the wizard. Defaults to "choose-folder". */
  initialStep?: OnboardingStep;
}

// ── Onboarding wizard ─────────────────────────────────────────────────────────

/**
 * The wizard is welcome → appearance → folder → workspace → project → done. AI
 * setup is not part of it: the key is added later in Settings → AI, and the chat
 * shows a prompt until it is set.
 */
export function Onboarding({ onComplete, initialStep = "choose-folder" }: Props) {
  const { theme, setTheme, fontScale, setFontScale, fontFamily, setFontFamily, createWorkspace, updateWorkspace, initWorkspacePath, getWorkspacePath, createProject, createNote, createCard, deleteProject, setActiveProject, activeWorkspaceId } = useCairnStore(useShallow((s) => ({ theme: s.theme, setTheme: s.setTheme, fontScale: s.fontScale, setFontScale: s.setFontScale, fontFamily: s.fontFamily, setFontFamily: s.setFontFamily, createWorkspace: s.createWorkspace, updateWorkspace: s.updateWorkspace, initWorkspacePath: s.initWorkspacePath, getWorkspacePath: s.getWorkspacePath, createProject: s.createProject, createNote: s.createNote, createCard: s.createCard, deleteProject: s.deleteProject, setActiveProject: s.setActiveProject, activeWorkspaceId: s.activeWorkspaceId })));

  // ── Wizard step ──────────────────────────────────────────────────────────────
  // First run starts on the welcome panel. The other entry points (existing
  // workspace, dev shortcut) skip it.
  const [step, setStep] = useState<OnboardingStep>(initialStep === "choose-folder" ? "welcome" : initialStep);

  // ── Workspace ────────────────────────────────────────────────────────────────
  const [chosenFolder, setChosenFolder] = useState<string | null>(null);
  const [wsName, setWsName] = useState("");
  const [wsIcon, setWsIcon] = useState(DEFAULT_WORKSPACE_ICON);
  const [submitting, setSubmitting] = useState(false);
  // The workspace this wizard created. Undoing an import keeps its record, so
  // picking the same folder again reuses it rather than adding a second one.
  const [createdWorkspace, setCreatedWorkspace] = useState<{ id: string; folder: string | null } | null>(null);
  // Vault detection (populated by probing the chosen folder).
  const [isObsidianVault, setIsObsidianVault] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [excludedFolders, setExcludedFolders] = useState<Set<string>>(new Set());
  // Projects auto-created from the vault by the post-workspace rescan. When
  // non-empty, the project step shows them for review instead of the form.
  const [importedProjects, setImportedProjects] = useState<ImportedProject[]>([]);
  // Visible on the import summary when a rollback/undo fails.
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  // ── First project ───────────────────────────────────────────────────────────
  const [projectName, setProjectName] = useState("");
  const [projectIcon, setProjectIcon] = useState(DEFAULT_PROJECT_ICON);
  const [creatingProject, setCreatingProject] = useState(false);
  // Resuming on the done step means the project was made before the app quit.
  const [hasProject, setHasProject] = useState(initialStep === "done");
  // Set when the starter project is created, so the done step can offer to remove it.
  const [sampleProjectId, setSampleProjectId] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = projectName.trim();
    if (!trimmed || creatingProject) return;
    if (!activeWorkspaceId) return setProjectError(NO_WORKSPACE_MESSAGE);
    setCreatingProject(true);
    setProjectError(null);
    try {
      const proj = await createProject(activeWorkspaceId, trimmed, projectIcon);
      setActiveProject(proj.id);
      setHasProject(true);
      setStep("done");
    } catch (err) {
      setProjectError(projectErrorMessage(err));
    } finally {
      setCreatingProject(false);
    }
  }

  /** Creates a starter project with a welcome note and a couple of cards, so the
   *  board, notes and the app tour all have content on a fresh install. */
  async function handleStarterProject() {
    if (creatingProject) return;
    if (!activeWorkspaceId) return setProjectError(NO_WORKSPACE_MESSAGE);
    setCreatingProject(true);
    setProjectError(null);
    try {
      const proj = await createProject(activeWorkspaceId, "Getting started", DEFAULT_PROJECT_ICON);
      setActiveProject(proj.id);
      setSampleProjectId(proj.id);
      createNote(proj.id, "Welcome to Cairn", "note", "", STARTER_NOTE);
      const columns = useCairnStore.getState().columns
        .filter((c) => c.projectId === proj.id)
        .sort((a, b) => a.order - b.order);
      const backlog = columns.find((c) => c.type === "backlog") ?? columns[0];
      const todo = columns.find((c) => c.type === "todo") ?? columns[0];
      if (backlog) createCard(backlog.id, proj.id, "Drag me to Todo");
      if (todo) createCard(todo.id, proj.id, "Plan the first thing you want to do");
      setHasProject(true);
      setStep("done");
    } catch (err) {
      setProjectError(projectErrorMessage(err));
    } finally {
      setCreatingProject(false);
    }
  }

  /** Removes the starter project. The tour needs project content, so it is no
   *  longer offered once the sample is gone. */
  function handleDeleteSample() {
    if (!sampleProjectId) return;
    deleteProject(sampleProjectId);
    setSampleProjectId(null);
    setHasProject(false);
  }

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
      const reuse = createdWorkspace && createdWorkspace.folder === chosenFolder ? createdWorkspace : null;
      if (reuse) updateWorkspace(reuse.id, { name: trimmed, icon: wsIcon });
      const ws = reuse ?? await createWorkspace(trimmed, wsIcon);
      setCreatedWorkspace({ id: ws.id, folder: chosenFolder });
      markOnboardingInProgress();
      // The workspace record now exists. Re-scan the chosen folder so any
      // existing Obsidian vault folders (or loose root .md files) are turned
      // into projects + notes, attached to the workspace we just created. The
      // initial scan in initWorkspace ran before the workspace existed, so it
      // couldn't auto-create projects. Capture the created projects so the
      // project step can show them for review instead of prompting to create one.
      try {
        const result = await ipcResult((e) => e.rescanWorkspace(ws.id, [...excludedFolders], true));
        setImportedProjects("data" in result ? result.data.createdProjects : []);
      } catch {
        // Best-effort — onboarding shouldn't block on the rescan.
        setImportedProjects([]);
      }
      setStep("create-project");
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

  // ── Routing ───────────────────────────────────────────────────────────────────

  if (step === "welcome") {
    return <StepWelcome onNext={() => setStep("appearance")} />;
  }

  if (step === "choose-folder") {
    return (
      <StepChooseFolder
        chosenFolder={chosenFolder}
        submitting={submitting}
        onChoose={handleChooseFolder}
        onBack={initialStep === "choose-folder" ? () => setStep("appearance") : undefined}
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
        fontFamily={fontFamily}
        onThemeChange={setTheme}
        onFontScaleChange={setFontScale}
        onFontFamilyChange={setFontFamily}
        onBack={initialStep === "choose-folder" ? () => setStep("welcome") : undefined}
        onNext={() => setStep(initialStep === "choose-folder" ? "choose-folder" : "create-project")}
      />
    );
  }

  if (step === "create-project") {
    // A vault import already created projects: review them here, with no back
    // step (going back would create a second workspace on resubmit).
    if (importedProjects.length > 0) {
      return (
        <StepImportedProjects
          projects={importedProjects}
          busy={submitting}
          error={rollbackError}
          onContinue={() => { setHasProject(true); setStep("done"); }}
          onUndo={handleRollbackImport}
        />
      );
    }
    return (
      <StepCreateProject
        name={projectName}
        icon={projectIcon}
        submitting={creatingProject}
        onNameChange={setProjectName}
        onIconChange={setProjectIcon}
        error={projectError}
        onSubmit={handleCreateProject}
        onSample={handleStarterProject}
      />
    );
  }

  // step === "done"
  return (
    <StepDone
      hasProject={hasProject}
      sampleProject={sampleProjectId !== null}
      onDeleteSample={handleDeleteSample}
      hasOtherProjects={importedProjects.length > 0}
      // Going back to the project form after creating a project would create a
      // second one. Back stays for a deleted sample and the vault import review.
      onBack={!hasProject || importedProjects.length > 0 ? () => setStep("create-project") : undefined}
      onComplete={onComplete}
    />
  );
}
