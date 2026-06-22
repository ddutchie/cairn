"use client";

import { useState, useEffect } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { DEFAULT_WORKSPACE_ICON } from "@/lib/workspace-icons";
import type { OnboardingStep } from "./shared";
import { StepChooseFolder } from "./StepChooseFolder";
import { StepWorkspaceDetails } from "./StepWorkspaceDetails";
import { StepAppearance } from "./StepAppearance";
import { StepAISetup } from "./StepAISetup";
import { StepMCP } from "./StepMCP";
import { StepEmbeddings } from "./StepEmbeddings";
import { StepViews } from "./StepViews";
import { StepDone } from "./StepDone";
import type { ToggleableView } from "@/store/slices/ui";

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  onComplete: () => void;
  /** Where to enter the wizard. Defaults to "choose-folder". */
  initialStep?: OnboardingStep;
}

// ── Onboarding wizard ─────────────────────────────────────────────────────────

export function Onboarding({ onComplete, initialStep = "choose-folder" }: Props) {
  const { createWorkspace, selectAndInitWorkspace, initWorkspacePath, getWorkspacePath, theme, setTheme, fontScale, setFontScale, aiConfig, setAIConfig, setAgentConfig, hiddenViews, setHiddenViews } = useCairnStore(useShallow((s) => ({ createWorkspace: s.createWorkspace, selectAndInitWorkspace: s.selectAndInitWorkspace, initWorkspacePath: s.initWorkspacePath, getWorkspacePath: s.getWorkspacePath, theme: s.theme, setTheme: s.setTheme, fontScale: s.fontScale, setFontScale: s.setFontScale, aiConfig: s.aiConfig, setAIConfig: s.setAIConfig, setAgentConfig: s.setAgentConfig, hiddenViews: s.hiddenViews, setHiddenViews: s.setHiddenViews })));

  // ── Wizard step ──────────────────────────────────────────────────────────────
  const [step, setStep] = useState<OnboardingStep>(initialStep);

  // ── Workspace ────────────────────────────────────────────────────────────────
  const [chosenFolder, setChosenFolder] = useState<string | null>(null);
  const [wsName, setWsName] = useState("");
  const [wsIcon, setWsIcon] = useState(DEFAULT_WORKSPACE_ICON);
  const [submitting, setSubmitting] = useState(false);

  // ── View visibility (local copy; committed when user hits Next on StepViews) ─
  const [localHidden, setLocalHidden] = useState<Set<ToggleableView>>(new Set(hiddenViews));

  function toggleLocalView(view: ToggleableView) {
    setLocalHidden((prev) => {
      const next = new Set(prev);
      if (next.has(view)) { next.delete(view); } else { next.add(view); }
      return next;
    });
  }

  // ── AI ───────────────────────────────────────────────────────────────────────
  const [aiEnabled, setAiEnabled] = useState(aiConfig.aiEnabled ?? true);
  const [provider, setProvider]   = useState<string>(aiConfig.provider ?? "openai");
  const [baseUrl, setBaseUrl]     = useState(aiConfig.baseUrl || "https://api.openai.com");
  const [apiKey, setApiKey]       = useState(aiConfig.apiKey || "");
  const [model, setModel]         = useState(aiConfig.model || "gpt-4o-mini");

  // ── Embeddings ───────────────────────────────────────────────────────────────
  const [embEnabled, setEmbEnabled] = useState(false);
  const [embModelId, setEmbModelId] = useState("Xenova/bge-small-en-v1.5");

  // Pre-populate folder path when skipping the folder-picker step
  useEffect(() => {
    if (initialStep !== "choose-folder") {
      getWorkspacePath().then((p) => { if (p) setChosenFolder(p); });
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
    setAIConfig({ aiEnabled, provider: provider as "openai" | "localllm", baseUrl, apiKey, model });
    if (provider !== "localllm") {
      setAgentConfig({ baseUrl, apiKey, model });
    }
    setStep("mcp");
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

  if (step === "mcp") {
    return (
      <StepMCP
        onBack={() => setStep("ai-setup")}
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
          setStep("done");
        }}
      />
    );
  }

  // step === "done"
  return (
    <StepDone
      onBack={() => setStep("views")}
      onComplete={onComplete}
    />
  );
}
