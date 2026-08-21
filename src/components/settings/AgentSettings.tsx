"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Star, FolderOpen, Check, BookOpen, ChevronDown, ChevronUp, Copy, FileCode, CheckCircle, RefreshCw, Download
} from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { id, cn } from "@/lib/utils";
import { contextLimitForModel, modelInfoForModel } from "@/lib/models-dev";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { CodingAgent } from "@/store/slices/coding-agents";
import { SettingsGroup, SettingsRow, StepperSettingsRow } from "./shared";
import { ProviderManager } from "./ProviderManager";
import { BrowseProvidersModal } from "./tools/BrowseProvidersModal";

// ── Agent form ────────────────────────────────────────────────────────────────

interface AgentFormProps {
  initial?: CodingAgent;
  onSave: (agent: Omit<CodingAgent, "createdAt" | "updatedAt">) => void;
  onCancel: () => void;
}

function AgentForm({ initial, onSave, onCancel }: AgentFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [binaryPath, setBinaryPath] = useState(initial?.binaryPath ?? "");
  const [args, setArgs] = useState(initial?.args ?? "");
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);

  const valid = name.trim().length > 0 && binaryPath.trim().length > 0;

  async function pickBinary() {
    const result = await window.electron?.agent.pickFile() as { data: string | null } | undefined;
    if (result?.data) setBinaryPath(result.data);
  }

  function submit() {
    if (!valid) return;
    onSave({
      id: initial?.id ?? id(),
      name: name.trim(),
      binaryPath: binaryPath.trim(),
      args: args.trim(),
      isDefault,
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] p-4 bg-[var(--surface-2)]">
      <div className="grid grid-cols-2 gap-3">
        {/* Name */}
        <div className="col-span-2">
          <label className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] block mb-1">
            Display Name *
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            placeholder="e.g. Claude Code"
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 focus:outline-none"
          />
        </div>

        {/* Binary path */}
        <div className="col-span-2">
          <label className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] block mb-1">
            Binary Path *
          </label>
          <div className="flex gap-2">
            <input
              value={binaryPath}
              onChange={(e) => setBinaryPath(e.target.value)}
              placeholder="/usr/local/bin/claude"
              className="flex-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 font-mono focus:outline-none"
            />
            <Button variant="ghost" size="sm" onClick={pickBinary}>
              <FolderOpen size={12} />
              Browse
            </Button>
          </div>
        </div>

        {/* Args */}
        <div className="col-span-2">
          <label className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] block mb-1">
            Arguments
            <span className="normal-case font-normal ml-1">
              — use <code className="text-[var(--accent)]">{"{\"{\\\"{prompt}\\\"}\"}"}</code> as placeholder, or leave empty for interactive
            </span>
          </label>
          <input
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="e.g. -p {prompt}  or  --message {prompt}  or  run {prompt}  or  leave empty for interactive"
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 font-mono focus:outline-none"
          />
          <p className="mt-1 text-[0.714rem] text-[var(--text-tertiary)]">
            Claude Code: binary <code className="text-[var(--accent)]">claude</code>, args <code className="text-[var(--accent)]">-p {"{prompt}"}</code>.{" "}
            OpenCode: binary <code className="text-[var(--accent)]">opencode</code>, args <code className="text-[var(--accent)]">--prompt {"{prompt}"}</code>.{" "}
            Aider: binary <code className="text-[var(--accent)]">aider</code>, args <code className="text-[var(--accent)]">--message {"{prompt}"}</code>.{" "}
            Gemini CLI: binary <code className="text-[var(--accent)]">gemini</code>, args <code className="text-[var(--accent)]">-p {"{prompt}"}</code>.{" "}
            Leave empty for pure interactive TUI.
          </p>
          {/* Live preview */}
          {binaryPath.trim() && (
            <p className="mt-1 text-[0.714rem] font-mono text-[var(--text-tertiary)] truncate">
              <span className="opacity-50">preview: </span>
              {binaryPath.trim()}
              {args.trim() ? ` ${args.trim()}` : ""}
            </p>
          )}
        </div>

        {/* Default toggle */}
        <div className="col-span-2 flex items-center gap-2">
          <input
            id="isDefault"
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          <label htmlFor="isDefault" className="text-sm text-[var(--text-secondary)]">
            Set as default agent
          </label>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={submit} disabled={!valid}>
          <Check size={12} />
          Save Agent
        </Button>
      </div>
    </div>
  );
}

// ── Skill row ─────────────────────────────────────────────────────────────────

interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  dirPath: string;
  license?: string;
  compatibility?: string;
}

function SkillRow({ skill }: { skill: SkillInfo }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[var(--border)] px-4 py-3 bg-[var(--surface)]">
      <div className="mt-0.5 flex-shrink-0 w-5 h-5 rounded bg-[var(--accent-dim)] flex items-center justify-center">
        <BookOpen size={11} className="text-[var(--accent)]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-[var(--text-primary)] font-mono">{skill.name}</span>
          {skill.compatibility && (
            <span className="text-[0.65rem] px-1.5 py-0.5 rounded-full bg-[var(--surface-3)] text-[var(--text-tertiary)] border border-[var(--border)]">
              {skill.compatibility}
            </span>
          )}
          {skill.license && (
            <span className="text-[0.65rem] px-1.5 py-0.5 rounded-full bg-[var(--surface-3)] text-[var(--text-tertiary)] border border-[var(--border)]">
              {skill.license}
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">{skill.description}</p>
        <p className="text-[0.714rem] font-mono text-[var(--text-tertiary)] mt-1 truncate" title={skill.filePath}>
          {skill.filePath}
        </p>
      </div>
    </div>
  );
}

// ── System prompt preview ─────────────────────────────────────────────────────

interface PromptPreviewProps {
  systemPrompt: string;
}

function PromptPreview({ systemPrompt }: PromptPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const { copied, copy: copyToClipboard } = useCopyToClipboard();

  const lines = systemPrompt.split("\n");
  const PREVIEW_LINES = 6;
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const hasMore = lines.length > PREVIEW_LINES;

  function copy() {
    copyToClipboard(systemPrompt);
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-[var(--border)] bg-[var(--surface-2)]">
        <div className="flex items-center gap-2">
          <FileCode size={12} className="text-[var(--text-tertiary)]" />
          <span className="text-xs font-medium text-[var(--text-secondary)]">System prompt</span>
          <span className="text-[0.65rem] text-[var(--text-tertiary)]">({lines.length} lines)</span>
        </div>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-2 py-1 rounded hover:bg-[var(--surface-3)]"
        >
          {copied
            ? <><CheckCircle size={11} className="text-[var(--success)]" /> Copied</>
            : <><Copy size={11} /> Copy</>
          }
        </button>
      </div>

      {/* Content */}
      <div className="relative">
        <pre className="text-[0.714rem] font-mono text-[var(--text-secondary)] leading-relaxed p-4 overflow-x-auto whitespace-pre-wrap break-words">
          {expanded ? systemPrompt : preview}
        </pre>
        {!expanded && hasMore && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[var(--surface)] to-transparent pointer-events-none" />
        )}
      </div>

      {/* Expand toggle */}
      {hasMore && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-center gap-1.5 py-2.5 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] border-t border-[var(--border)] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] transition-colors"
        >
          {expanded
            ? <><ChevronUp size={12} /> Collapse</>
            : <><ChevronDown size={12} /> Show all ({lines.length} lines)</>
          }
        </button>
      )}
    </div>
  );
}

// ── Skills & prompt preview section ──────────────────────────────────────────

function SkillsPreviewSection() {
  const { projects, activeProjectId } = useCairnStore(useShallow((s) => ({
    projects: s.projects,
    activeProjectId: s.activeProjectId,
  })));

  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [mode, setMode] = useState<"execute" | "plan">("execute");
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [sections, setSections] = useState<Array<{ name: string; order: number; text: string; index: number }> | null>(null);
  const [skillCount, setSkillCount] = useState<number | null>(null);
  const [toolCount, setToolCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];
  const activeProjectIdForLoad = activeProject?.id;

  useEffect(() => {
    window.electron?.getWorkspacePath().then((p) => setWorkspacePath(p ?? null));
  }, []);

  const load = useCallback(async () => {
    if (!workspacePath) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electron?.piAgent.previewPrompt({
        cwd: workspacePath,
        projectId: activeProjectIdForLoad ?? undefined,
        mode,
      });
      if (result) {
        setSkills(result.skills);
      }
      // The REAL assembled prompt now comes from the Cordis engine (dsh
      // SystemPrompt), not the legacy pi-agent builder.
      const promptRes = await window.electron?.runtime?.systemPromptPreview({ cwd: workspacePath });
      if (promptRes) {
        if (promptRes.error) setError(promptRes.error);
        setSystemPrompt(promptRes.text || null);
        setSections(promptRes.sections);
        setSkillCount(promptRes.skillCount);
        setToolCount(promptRes.toolCount);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspacePath, activeProjectIdForLoad, mode]);

  // Auto-load on mount and when deps change
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  return (
    <SettingsGroup
      title="Skills & System Prompt"
      description="SKILL.md files discovered in your workspace are automatically loaded into the agent context. Preview the full system prompt the agent will receive."
    >
      {/* Mode toggle + refresh */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
          {(["execute", "plan"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "px-3 py-1 text-xs rounded-md transition-colors capitalize",
                mode === m
                  ? "bg-[var(--accent)] text-[var(--background)] font-medium"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              )}
            >
              {m} mode
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={load}
          disabled={loading}
          className={cn(loading && "opacity-50")}
        >
          <RefreshCw size={11} className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Workspace path context */}
      {workspacePath && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
          <FolderOpen size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
          <span className="text-[0.714rem] font-mono text-[var(--text-tertiary)] truncate">{workspacePath}</span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-4 py-3">
          <p className="text-xs text-[var(--danger)]">{error}</p>
        </div>
      )}

      {/* Skills list */}
      {skills !== null && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">
              Discovered Skills
            </h3>
            <span className="text-[0.65rem] text-[var(--text-tertiary)]">
              {skills.length === 0 ? "none" : `${skills.length} skill${skills.length !== 1 ? "s" : ""}`}
            </span>
          </div>

          {skills.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-center space-y-2">
              <BookOpen size={20} className="mx-auto text-[var(--text-tertiary)] opacity-40" />
              <p className="text-xs text-[var(--text-tertiary)]">No skills found</p>
              <p className="text-[0.714rem] text-[var(--text-tertiary)] leading-relaxed max-w-xs mx-auto">
                Create a <code className="font-mono bg-[var(--surface-3)] px-1 rounded">.cairn/skills/&lt;name&gt;/SKILL.md</code> file in your workspace to get started. Compatible with OpenCode, Cline, and Claude Code skill formats.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {skills.map((skill) => (
                <SkillRow key={skill.name} skill={skill} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* System prompt preview (live dsh assembly) */}
      {systemPrompt !== null && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)] mb-2">
            Assembled System Prompt
          </h3>
          {sections && sections.length > 0 && (
            <div className="mb-3 space-y-1.5">
              <div className="flex items-center gap-2 text-[0.714rem] text-[var(--text-tertiary)]">
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--surface-3)]">
                  {sections.length} section{sections.length !== 1 ? "s" : ""}
                </span>
                {skillCount !== null && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--surface-3)]">
                    {skillCount} skills
                  </span>
                )}
                {toolCount !== null && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--surface-3)]">
                    {toolCount} tools
                  </span>
                )}
              </div>
              <div className="space-y-1">
                {sections.map((s) => (
                  <div key={`${s.index}-${s.name}`} className="flex items-start gap-2">
                    <span className="text-[0.65rem] font-mono text-[var(--text-tertiary)] pt-0.5 w-6 shrink-0 text-right">
                      {s.index + 1}
                    </span>
                    <span className="text-[0.714rem] font-mono text-[var(--accent)] pt-0.5 shrink-0">
                      {s.name}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <PromptPreview systemPrompt={systemPrompt} />
        </div>
      )}

      {loading && skills === null && (
        <div className="py-8 text-center">
          <RefreshCw size={16} className="mx-auto animate-spin text-[var(--text-tertiary)] opacity-50" />
        </div>
      )}
    </SettingsGroup>
  );
}

// ── AgentSettings ─────────────────────────────────────────────────────────────

export function AgentSettings() {
  const { agents, fetchAgents, saveAgent, deleteAgent, setDefaultAgent, agentConfig, setAgentConfig } = useCairnStore(useShallow((s) => ({
    agents:          s.agents,
    fetchAgents:     s.fetchAgents,
    saveAgent:       s.saveAgent,
    deleteAgent:     s.deleteAgent,
    setDefaultAgent: s.setDefaultAgent,
    agentConfig:     s.agentConfig,
    setAgentConfig:  s.setAgentConfig,
  })));

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [browsingProviders, setBrowsingProviders] = useState(false);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  // Connection fields (baseUrl/apiKey/model) are managed by the ProviderManager
  // switcher below; here we only need `model` (context lookup) + behavioural fields.
  const { model: modelAgent, maxSteps: maxStepsAgent, temperature: temperatureAgent, contextLimit: contextLimitAgent, autoApprove = true } = agentConfig;

  function updateAgent(patch: Partial<typeof agentConfig>) {
    setAgentConfig(patch);
  }

  // Look up the agent model's context window from models.dev (cached). When Auto
  // is enabled, the detected value is applied to contextLimit automatically as
  // the model changes; a manual value or preset turns Auto off. Cloud only.
  const contextAutoAgent = agentConfig.contextAuto ?? true;
  const [detectedContextAgent, setDetectedContextAgent] = useState<number | null>(null);
  const [autoStateAgent, setAutoStateAgent] = useState<"idle" | "loading" | "detected" | "not_found">("idle");
  useEffect(() => {
    let cancelled = false;
    const mid = (modelAgent ?? "").trim();
    if (!mid) { setDetectedContextAgent(null); setAutoStateAgent("idle"); return; } // eslint-disable-line react-hooks/set-state-in-effect
    setAutoStateAgent("loading");
    contextLimitForModel(mid, 0).then((n) => {
      if (cancelled) return;
      const found = n > 0 ? n : null;
      setDetectedContextAgent(found);
      setAutoStateAgent(found ? "detected" : "not_found");
      // Auto-apply when Auto mode is on. Read the LATEST config from the store to
      // avoid stale-closure races when switching models quickly.
      if (found) {
        const cur = useCairnStore.getState().agentConfig;
        if ((cur.contextAuto ?? true) && cur.contextLimit !== found) {
          setAgentConfig({ contextLimit: found });
        }
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelAgent, contextAutoAgent]);

  // Max output tokens — Auto (default) sends a generous 32K cap (bounded by the
  // model's advertised limit.output) so the model finishes naturally; a manual
  // value is a deliberate cost/latency ceiling. Same rationale as AI Chat.
  const maxOutputAutoAgent = agentConfig.maxOutputAuto ?? true;
  const [advertisedMaxOutputAgent, setAdvertisedMaxOutputAgent] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const mid = (modelAgent ?? "").trim();
    if (!mid) { setAdvertisedMaxOutputAgent(null); return; } // eslint-disable-line react-hooks/set-state-in-effect
    modelInfoForModel(mid).then((info) => {
      if (cancelled) return;
      setAdvertisedMaxOutputAgent(info?.maxOutput ?? null);
    });
    return () => { cancelled = true; };
  }, [modelAgent]);

  // Whether the agent model supports temperature control (models.dev `temperature`).
  // false = vendor manages sampling internally; nothing is sent.
  const [temperatureCapabilityAgent, setTemperatureCapabilityAgent] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const mid = (modelAgent ?? "").trim();
    if (!mid) { setTemperatureCapabilityAgent(null); return; } // eslint-disable-line react-hooks/set-state-in-effect
    modelInfoForModel(mid).then((info) => {
      if (cancelled) return;
      setTemperatureCapabilityAgent(info?.temperature ?? null);
    });
    return () => { cancelled = true; };
  }, [modelAgent]);

  async function handleSaveAgent(agent: Omit<CodingAgent, "createdAt" | "updatedAt">) {
    await saveAgent(agent);
    setAdding(false);
    setEditingId(null);
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Coding Agents</h2>
        <p className="text-xs text-[var(--text-tertiary)]">
          Configure the native Cairn coding agent loop and register external coding agent CLIs.
        </p>
      </div>

      {/* ── Cairn Agent (Pi Agent) Endpoint ── */}
      <SettingsGroup
        title="Cairn Coding Agent (Pi)"
        description="Configure endpoint parameters for the native autonomous coding agent. Coding agents require high-capacity cloud/local models supporting function calling."
      >
        {/* Install a preset provider from the cairn-community catalog. Shares
            the same saved-providers list as AI Chat. */}
        <SettingsRow
          label="Community providers"
          description="Install a ready-made OpenAI-compatible provider (endpoint + default model) and just enter your API key. Added to your saved providers below."
        >
          <button
            onClick={() => setBrowsingProviders(true)}
            className="px-2.5 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <Download size={12} /> Browse Community
          </button>
        </SettingsRow>

        {/* Saved providers switcher (base URL, key, model all live in the form) */}
        <ProviderManager kind="agent" />

        {/* Max steps */}
        <StepperSettingsRow
          label="Max steps"
          description="Tool-call rounds the agent can take per message. Use ∞ for complex multi-file tasks — but watch API costs."
          icon="footprints"
          value={maxStepsAgent ?? 30}
          onChange={(v) => updateAgent({ maxSteps: v })}
          presets={[10, 20, 30, 50, 1000]}
          min={1}
          max={1000}
          formatPreset={(n) => (n === 1000 ? "∞" : String(n))}
        />

        {/* Temperature */}
        <StepperSettingsRow
          label="Temperature"
          description={
            temperatureAgent == null
              ? temperatureCapabilityAgent === false
                ? `Auto: no temperature is sent for "${modelAgent}" — models.dev reports it doesn't support temperature control. Plan mode always uses 0.1 regardless of this setting.`
                : `Auto: no temperature is sent, so "${modelAgent}" uses its own default. Plan mode always uses 0.1 regardless of this setting. Set a value to override for models that support it.`
              : temperatureCapabilityAgent === false
                ? `"${modelAgent}" doesn't support temperature control (per models.dev) — this value is ignored and nothing is sent. Plan mode always uses 0.1 regardless of this setting.`
                : `Sampling temperature for the agent (0–1). Lower = more deterministic. Plan mode always uses 0.1 regardless of this setting. Tap Auto to let the model use its own default.`
          }
          icon="thermometer"
          value={temperatureAgent ?? 0.3}
          onChange={(v) => updateAgent({ temperature: v })}
          presets={[0.1, 0.3, 0.5, 0.7, 1.0]}
          min={0}
          max={1}
          step={0.05}
          autoActive={temperatureAgent == null}
          onAuto={() => updateAgent({ temperature: undefined })}
          autoSuppressesValue
          suppressedPlaceholder="Auto"
        />

        {/* Context window */}
        <StepperSettingsRow
          label="Context window"
          description={
            contextAutoAgent && autoStateAgent === "detected" && detectedContextAgent
              ? `Auto: using ${detectedContextAgent.toLocaleString()} tokens detected from models.dev for "${modelAgent}". Set a value to override. Displays the context usage ring — does not truncate API calls.`
              : contextAutoAgent && autoStateAgent === "not_found"
                ? `"${modelAgent}" isn't in the models.dev catalog, so Auto can't detect its size. Set the context size manually.`
                : autoStateAgent === "detected" && detectedContextAgent
                  ? `Manual override. models.dev reports ${detectedContextAgent.toLocaleString()} tokens for "${modelAgent}" — tap Auto to use it.`
                  : "Token limit of your model. Used to display the context usage ring in the coding agent — does not truncate or limit API calls. Tap Auto to detect it from models.dev."
          }
          icon="layers"
          value={contextLimitAgent ?? 128000}
          onChange={(v) => updateAgent({ contextLimit: v, contextAuto: false })}
          presets={[8000, 32000, 128000, 200000]}
          min={1000}
          max={2000000}
          step={1000}
          inputWidth="w-28"
          formatPreset={(n) => (n >= 1000 ? `${n / 1000}k` : String(n))}
          autoValue={detectedContextAgent ?? undefined}
          autoState={contextAutoAgent ? autoStateAgent : "idle"}
          autoActive={contextAutoAgent}
          onAuto={() =>
            updateAgent({
              contextAuto: true,
              contextLimit: detectedContextAgent ?? contextLimitAgent ?? 128000,
            })
          }
        />

        {/* Max output tokens — Auto (default) sends a bounded 32K cap (clamped to
            the model's limit.output) so the model finishes naturally; a manual
            value is a deliberate cost/latency ceiling. */}
        <StepperSettingsRow
          label="Max output tokens"
          description={
            maxOutputAutoAgent
              ? advertisedMaxOutputAgent
                ? `Auto: a 32K cap, clamped to "${modelAgent}"'s ${advertisedMaxOutputAgent.toLocaleString()} output tokens (models.dev). The model finishes on its own unless its limit is lower. Recommended, especially for reasoning models. Set a value only to cap cost.`
                : "Auto: a 32K cap so the model finishes on its own (the cap is clamped to the model's output limit when models.dev knows it). Recommended, especially for reasoning models, which need room to think before acting. Set a value only to cap cost per turn."
              : advertisedMaxOutputAgent
                ? `Manual cap per turn. Reasoning models count their thinking against this, so too low a value can stall them before they act. "${modelAgent}" supports up to ${advertisedMaxOutputAgent.toLocaleString()} tokens (models.dev). Tap Auto for the bounded 32K cap.`
                : "Manual cap on output tokens per turn. Reasoning models count their thinking against this, so too low a value can stall them. Tap Auto for the bounded 32K cap."
          }
          icon="gauge"
          value={agentConfig.maxOutputTokens ?? 8192}
          onChange={(v) => updateAgent({ maxOutputTokens: v, maxOutputAuto: false })}
          presets={[4096, 8192, 16384, 32768, 65536]}
          min={256}
          max={advertisedMaxOutputAgent ?? 384000}
          step={256}
          inputWidth="w-28"
          formatPreset={(n) => (n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n))}
          autoState={maxOutputAutoAgent ? "detected" : "idle"}
          autoActive={maxOutputAutoAgent}
          autoSuppressesValue
          suppressedPlaceholder="Auto (32K)"
          onAuto={() => updateAgent({ maxOutputAuto: true })}
        />

        {/* Auto-approve */}
        <SettingsRow
          label="Auto-approve tool execution"
          description="When disabled, the agent will pause and prompt for confirmation before running any shell commands, writing files, or managing boards."
        >
          <input
            id="autoApprove"
            type="checkbox"
            checked={autoApprove}
            onChange={(e) => updateAgent({ autoApprove: e.target.checked })}
            className="w-4 h-4 rounded border-[var(--border)] bg-[var(--surface-2)] text-[var(--accent)] accent-[var(--accent)] cursor-pointer"
          />
        </SettingsRow>
      </SettingsGroup>

      {/* Agent list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">
            Configured CLI Agents
          </h3>
          {!adding && (
            <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
              <Plus size={12} />
              Add Agent CLI
            </Button>
          )}
        </div>

        {adding && (
          <AgentForm
            onSave={handleSaveAgent}
            onCancel={() => setAdding(false)}
          />
        )}

        {agents.length === 0 && !adding && (
          <p className="text-xs text-[var(--text-tertiary)] py-4 text-center border border-dashed border-[var(--border)] rounded-lg">
            No external agents configured yet. Click &quot;Add Agent CLI&quot; to register one.
          </p>
        )}

        {agents.map((agent) =>
          editingId === agent.id ? (
            <AgentForm
              key={agent.id}
              initial={agent}
              onSave={handleSaveAgent}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div
              key={agent.id}
              className="flex items-center gap-3 rounded-lg border border-[var(--border)] px-4 py-3 bg-[var(--surface)]"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text-primary)]">{agent.name}</span>
                  {agent.isDefault && (
                    <span className="text-[0.65rem] px-1.5 py-0.5 rounded-full bg-[var(--accent-dim)] text-[var(--accent)]">
                      default
                    </span>
                  )}
                </div>
                <span className="text-[0.714rem] font-mono text-[var(--text-tertiary)] truncate block">
                  {agent.binaryPath}{agent.args ? ` ${agent.args}` : ""}
                </span>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {!agent.isDefault && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setDefaultAgent(agent.id)}
                    title="Set as default"
                    className="text-[var(--text-tertiary)] hover:text-[var(--accent)]"
                  >
                    <Star size={11} />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setEditingId(agent.id)}
                  className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => deleteAgent(agent.id)}
                  className="text-[var(--danger)] hover:bg-[var(--danger)]/10"
                >
                  <Trash2 size={11} />
                </Button>
              </div>
            </div>
          )
        )}
      </div>

      {/* Skills & system prompt preview */}
      <SkillsPreviewSection />

      {browsingProviders && <BrowseProvidersModal onClose={() => setBrowsingProviders(false)} />}
    </div>
  );
}
