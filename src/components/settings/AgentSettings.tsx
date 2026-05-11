"use client";

/**
 * AgentSettings — "Coding Agents" section of Settings.
 *
 * Lets users register/edit/delete AI coding agent CLI configurations
 * (Claude Code, OpenCode, Aider, etc.) and set a global default.
 * Also shows the code directory for the active project.
 *
 * Includes a Skills & System Prompt preview section showing which
 * SKILL.md files were discovered and the full assembled system prompt.
 */

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Star, FolderOpen, Check, BookOpen, ChevronDown, ChevronUp, Copy, CheckCircle, RefreshCw, FileCode } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { id, cn } from "@/lib/utils";
import type { CodingAgent } from "@/store/slices/coding-agents";
import { SettingsGroup } from "./shared";

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
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
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
              className="flex-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
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
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
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
                  ? "bg-[var(--accent)] text-white font-medium"
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
  const { agents, fetchAgents, saveAgent, deleteAgent, setDefaultAgent } = useCairnStore(useShallow((s) => ({ agents: s.agents, fetchAgents: s.fetchAgents, saveAgent: s.saveAgent, deleteAgent: s.deleteAgent, setDefaultAgent: s.setDefaultAgent })));

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

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
          Register AI coding agent CLIs. Cairn spawns them in embedded terminal sessions from task cards.
        </p>
      </div>

      {/* Agent list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">
            Configured Agents
          </h3>
          {!adding && (
            <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
              <Plus size={12} />
              Add Agent
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
            No agents configured yet. Click &quot;Add Agent&quot; to register one.
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
