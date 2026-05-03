"use client";

import { useState, useEffect } from "react";
import { useCairnStore } from "@/store";
import { DEFAULT_WORKSPACE_ICON } from "@/lib/workspace-icons";
import type { OnboardingStep } from "./shared";
import { StepChooseFolder } from "./StepChooseFolder";
import { StepWorkspaceDetails } from "./StepWorkspaceDetails";
import { StepAppearance } from "./StepAppearance";
import { StepAISetup } from "./StepAISetup";
import { StepMCP } from "./StepMCP";
import { StepDone } from "./StepDone";

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  onComplete: () => void;
  /** Where to enter the wizard. Defaults to "choose-folder". */
  initialStep?: OnboardingStep;
}

// ── Onboarding wizard ─────────────────────────────────────────────────────────

export function Onboarding({ onComplete, initialStep = "choose-folder" }: Props) {
  const {
    createWorkspace, selectAndInitWorkspace, initWorkspacePath, getWorkspacePath,
    theme, setTheme,
    fontScale, setFontScale,
    aiConfig, setAIConfig,
  } = useCairnStore();

  // ── Wizard step ──────────────────────────────────────────────────────────────
  const [step, setStep] = useState<OnboardingStep>(initialStep);

  // ── Workspace ────────────────────────────────────────────────────────────────
  const [chosenFolder, setChosenFolder] = useState<string | null>(null);
  const [wsName, setWsName] = useState("");
  const [wsIcon, setWsIcon] = useState(DEFAULT_WORKSPACE_ICON);
  const [submitting, setSubmitting] = useState(false);

  // ── AI ───────────────────────────────────────────────────────────────────────
  const [aiEnabled, setAiEnabled] = useState(aiConfig.aiEnabled ?? true);
  const [baseUrl, setBaseUrl]     = useState(aiConfig.baseUrl || "https://api.openai.com");
  const [apiKey, setApiKey]       = useState(aiConfig.apiKey || "");
  const [model, setModel]         = useState(aiConfig.model || "gpt-4o-mini");

  // Pre-populate folder path when skipping the folder-picker step
  useEffect(() => {
    if (initialStep !== "choose-folder") {
      getWorkspacePath().then((p) => { if (p) setChosenFolder(p); });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialStep]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  async function handleChooseFolder() {
    setSubmitting(true);
    try {
      const folder = await selectAndInitWorkspace();
      if (!folder) return;
      setChosenFolder(folder);
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
        await initWorkspacePath(chosenFolder);
      }
      await createWorkspace(trimmed, wsIcon);
      setStep("appearance");
    } finally {
      setSubmitting(false);
    }
  }

  function handleSaveAI() {
    setAIConfig({ aiEnabled, baseUrl, apiKey, model });
    setStep("mcp");
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
        onBack={() => setStep("choose-folder")}
        onNameChange={setWsName}
        onIconChange={setWsIcon}
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
        baseUrl={baseUrl}
        apiKey={apiKey}
        model={model}
        onAiEnabledChange={setAiEnabled}
        onBaseUrlChange={setBaseUrl}
        onApiKeyChange={setApiKey}
        onModelChange={setModel}
        onBack={() => setStep("appearance")}
        onNext={handleSaveAI}
      />
    );
  }

  if (step === "mcp") {
    return (
      <StepMCP
        onBack={() => setStep("ai-setup")}
        onNext={() => setStep("done")}
      />
    );
  }

  // step === "done"
  return (
    <StepDone
      onBack={() => setStep("mcp")}
      onComplete={onComplete}
    />
  );
}
