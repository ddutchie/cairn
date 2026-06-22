"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Star, FolderOpen, Check, BookOpen, ChevronDown, ChevronUp, Copy, CheckCircle, RefreshCw, FileCode,
  Key, Globe, Cpu, Wifi, WifiOff, Eye, EyeOff, Footprints, Layers, Thermometer
} from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { id, cn } from "@/lib/utils";
import type { CodingAgent } from "@/store/slices/coding-agents";
import { SettingsGroup, SettingsRow } from "./shared";

type TestState = "idle" | "testing" | "ok" | "error";

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
  const [copied, setCopied] = useState(false);

  const lines = systemPrompt.split("\n");
  const PREVIEW_LINES = 6;
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const hasMore = lines.length > PREVIEW_LINES;

  function copy() {
    navigator.clipboard.writeText(systemPrompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
        setSystemPrompt(result.systemPrompt);
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

      {/* System prompt preview */}
      {systemPrompt !== null && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)] mb-2">
            Assembled System Prompt
          </h3>
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

  const [showKeyAgent, setShowKeyAgent] = useState(false);
  const [testStateAgent, setTestStateAgent] = useState<TestState>("idle");
  const [testErrorAgent, setTestErrorAgent] = useState("");

  const [availableModelsAgent, setAvailableModelsAgent] = useState<string[]>([]);
  const [modelsLoadingAgent, setModelsLoadingAgent] = useState(false);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  const { baseUrl: baseUrlAgent, model: modelAgent, apiKey: apiKeyAgent, maxSteps: maxStepsAgent, temperature: temperatureAgent, contextLimit: contextLimitAgent, autoApprove = true } = agentConfig;
  const isLocalAgent =
    baseUrlAgent.includes("localhost") ||
    baseUrlAgent.includes("127.0.0.1") ||
    baseUrlAgent.includes("0.0.0.0");

  function updateAgent(patch: Partial<typeof agentConfig>) {
    setAgentConfig(patch);
    if (patch.baseUrl !== undefined) {
      setAvailableModelsAgent([]);
    }
  }

  async function fetchModelsAgent() {
    setModelsLoadingAgent(true);
    try {
      const url = (baseUrlAgent || "https://api.openai.com").replace(/\/+$/, "").replace(/\/v1$/, "");
      const headers: Record<string, string> = {};
      if (apiKeyAgent) headers["Authorization"] = `Bearer ${apiKeyAgent}`;

      const res = await fetch(`${url}/v1/models`, { headers });
      if (!res.ok) throw new Error(`${res.status}`);

      const data = await res.json();
      const ids: string[] = (data?.data ?? [])
        .map((m: { id: string }) => m.id)
        .filter((id: string) => {
          return !id.includes("embed") && !id.includes("whisper") && !id.includes("tts") && !id.includes("dall-e");
        })
        .sort();

      setAvailableModelsAgent(ids);
      setTestStateAgent("ok");
    } catch (err) {
      setTestStateAgent("error");
      setTestErrorAgent(err instanceof Error ? err.message : "Failed to fetch models");
      setAvailableModelsAgent([]);
    } finally {
      setModelsLoadingAgent(false);
      setTimeout(() => setTestStateAgent("idle"), 5000);
    }
  }

  const fallbackModelsAgent = isLocalAgent
    ? ["llama3.2", "llama3.1", "qwen2.5:14b", "mistral", "phi4", "gemma3:12b"]
    : ["gpt-4o", "gpt-4-turbo", "gpt-4o-mini", "o1-mini", "o3-mini"];

  const modelOptionsAgent = availableModelsAgent.length > 0 ? availableModelsAgent : fallbackModelsAgent;

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
        {/* Base URL */}
        <SettingsRow
          label="Base URL"
          description="Root URL for the Coding Agent loop. Appends /v1/chat/completions."
        >
          <div className="flex flex-col gap-1.5 items-end">
            <div className="relative">
              <Globe size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
              <input
                type="url"
                value={baseUrlAgent}
                onChange={(e) => updateAgent({ baseUrl: e.target.value })}
                placeholder="https://api.openai.com"
                className="pl-7 pr-3 py-1.5 text-xs w-64 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div className="flex gap-1.5">
              {[
                { label: "OpenAI", url: "https://api.openai.com" },
                { label: "Ollama", url: "http://localhost:11434" },
                { label: "LM Studio", url: "http://localhost:1234" },
              ].map(({ label, url }) => (
                <button
                  key={label}
                  onClick={() => updateAgent({ baseUrl: url })}
                  className={cn(
                    "px-2 py-1 text-[0.714rem] rounded border transition-colors cursor-pointer",
                    baseUrlAgent === url
                      ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                      : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </SettingsRow>

        {/* API Key */}
        <SettingsRow
          label="API Key"
          description={
            isLocalAgent
              ? "Local servers don't need a key — leave blank."
              : "Required for OpenAI. Leave blank to use the OPENAI_API_KEY server env var."
          }
        >
          <div className="relative">
            <Key size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
            <input
              type={showKeyAgent ? "text" : "password"}
              value={apiKeyAgent}
              onChange={(e) => updateAgent({ apiKey: e.target.value })}
              placeholder={isLocalAgent ? "optional" : "sk-…"}
              className="pl-7 pr-8 py-1.5 text-xs w-52 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
            />
            <Tooltip content={showKeyAgent ? "Hide API key" : "Show API key"} side="top">
              <button
                onClick={() => setShowKeyAgent((s) => !s)}
                aria-label={showKeyAgent ? "Hide API key" : "Show API key"}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              >
                {showKeyAgent ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
            </Tooltip>
          </div>
        </SettingsRow>

        {/* Model Selection */}
        <SettingsRow
          label="Model"
          description={
            availableModelsAgent.length > 0
              ? `${availableModelsAgent.length} models loaded from endpoint`
              : "Type a model name or fetch the list from your endpoint."
          }
        >
          <div className="flex flex-col gap-1.5 items-end w-64">
            <div className="flex gap-1.5 w-full">
              <div className="relative flex-1">
                <Cpu size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                <input
                  type="text"
                  value={modelAgent}
                  onChange={(e) => updateAgent({ model: e.target.value })}
                  placeholder="gpt-4o"
                  className="pl-7 pr-3 py-1.5 text-xs w-full rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
              <button
                onClick={fetchModelsAgent}
                disabled={modelsLoadingAgent}
                aria-label="Fetch agent models from endpoint"
                className={cn(
                  "px-2 py-1.5 text-[0.714rem] rounded-md border transition-colors flex items-center gap-1 min-w-[52px] justify-center",
                  "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]",
                  modelsLoadingAgent && "opacity-50 cursor-wait"
                )}
              >
                <RefreshCw size={11} className={modelsLoadingAgent ? "animate-spin" : ""} />
                {modelsLoadingAgent ? "…" : "Fetch"}
              </button>
            </div>

            {testStateAgent === "error" && (
              <p className="text-[0.786rem] text-[var(--danger)] self-start" title={testErrorAgent}>
                {testErrorAgent.slice(0, 60)}
              </p>
            )}
            {testStateAgent === "ok" && availableModelsAgent.length > 0 && (
              <p className="text-[0.786rem] text-[var(--success)] self-start flex items-center gap-1">
                <CheckCircle size={10} /> {availableModelsAgent.length} models available
              </p>
            )}

            <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto w-full pr-0.5">
              {modelOptionsAgent.map((m) => (
                <button
                  key={m}
                  onClick={() => updateAgent({ model: m })}
                  className={cn(
                    "px-2 py-0.5 text-[0.714rem] rounded border transition-colors font-mono whitespace-nowrap",
                    modelAgent === m
                      ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                      : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </SettingsRow>

        {/* Max steps */}
        <SettingsRow
          label="Max steps"
          description="Tool-call rounds the agent can take per message. Use ∞ for complex multi-file tasks — but watch API costs."
        >
          <div className="flex flex-col gap-1.5 items-end">
            <div className="relative">
              <Footprints size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
              <input
                type="number"
                min={1}
                max={1000}
                value={maxStepsAgent ?? 30}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 1 && v <= 1000) updateAgent({ maxSteps: v });
                }}
                className="pl-7 pr-3 py-1.5 text-xs w-24 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div className="flex gap-1.5">
              {([10, 20, 30, 50] as const).map((n) => (
                <button
                  key={n}
                  onClick={() => updateAgent({ maxSteps: n })}
                  className={cn(
                    "px-2 py-1 text-[0.714rem] rounded border transition-colors",
                    (maxStepsAgent ?? 30) === n
                      ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                      : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
                  )}
                >
                  {n}
                </button>
              ))}
              <button
                onClick={() => updateAgent({ maxSteps: 1000 })}
                className={cn(
                  "px-2 py-1 text-[0.714rem] rounded border transition-colors",
                  (maxStepsAgent ?? 30) === 1000
                    ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                    : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
                )}
              >
                ∞
              </button>
            </div>
          </div>
        </SettingsRow>

        {/* Temperature */}
        <SettingsRow
          label="Temperature"
          description="Sampling temperature for the agent (0–1). Lower = more deterministic. Plan mode always uses 0.1 regardless of this setting."
        >
          <div className="flex flex-col gap-1.5 items-end">
            <div className="relative">
              <Thermometer size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={temperatureAgent ?? 0.3}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!isNaN(v) && v >= 0 && v <= 1) updateAgent({ temperature: v });
                }}
                className="pl-7 pr-3 py-1.5 text-xs w-24 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div className="flex gap-1.5">
              {[0.1, 0.3, 0.5, 0.7].map((n) => (
                <button
                  key={n}
                  onClick={() => updateAgent({ temperature: n })}
                  className={cn(
                    "px-2 py-1 text-[0.714rem] rounded border transition-colors",
                    (temperatureAgent ?? 0.3) === n
                      ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                      : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </SettingsRow>

        {/* Context window */}
        <SettingsRow
          label="Context window"
          description="Token limit of your model. Used to display the context usage ring in the coding agent — does not truncate or limit API calls."
        >
          <div className="flex flex-col gap-1.5 items-end">
            <div className="relative">
              <Layers size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
              <input
                type="number"
                min={1000}
                max={2000000}
                step={1000}
                value={contextLimitAgent ?? 128000}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 1000) updateAgent({ contextLimit: v });
                }}
                className="pl-7 pr-3 py-1.5 text-xs w-28 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div className="flex gap-1.5">
              {[8000, 32000, 128000, 200000].map((n) => (
                <button
                  key={n}
                  onClick={() => updateAgent({ contextLimit: n })}
                  className={cn(
                    "px-2 py-1 text-[0.714rem] rounded border transition-colors",
                    (contextLimitAgent ?? 128000) === n
                      ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                      : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
                  )}
                >
                  {n >= 1000 ? `${n / 1000}k` : n}
                </button>
              ))}
            </div>
          </div>
        </SettingsRow>

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

        {/* Agent Connection Status */}
        <div className="flex items-center gap-3 pt-1 text-xs">
          <span className={cn(
            "flex items-center gap-1",
            testStateAgent === "ok" ? "text-[var(--success)]" : testStateAgent === "error" ? "text-[var(--danger)]" : "text-[var(--text-tertiary)]"
          )}>
            {testStateAgent === "ok" && <><CheckCircle size={11} /> Connected</>}
            {testStateAgent === "error" && <><WifiOff size={11} /> Error</>}
            {(testStateAgent === "idle" || testStateAgent === "testing") && <><Wifi size={11} /> {testStateAgent === "testing" ? "Connecting…" : "Not tested"}</>}
          </span>
          <span className="text-[var(--text-tertiary)]">·</span>
          <span className="text-[var(--text-tertiary)] font-mono truncate max-w-40">{baseUrlAgent.replace(/^https?:\/\//, "")}</span>
          <span className="text-[var(--text-tertiary)]">·</span>
          <span className="text-[var(--text-tertiary)] font-mono">{modelAgent || "no model"}</span>
        </div>
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
    </div>
  );
}
