"use client";

import React, { useState, useEffect } from "react";
import {
  Settings,
  Database,
  Trash2,
  Download,
  Bot,
  Key,
  Globe,
  Keyboard,
  Info,
  CheckCircle,
  Zap,
  ZapOff,
  RefreshCw,
  Copy,
  Eye,
  EyeOff,
  Cpu,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { useCairnStore, DEFAULT_AI_CONFIG } from "@/store";
import { storage } from "@/lib/storage";
import { cn } from "@/lib/utils";


type SettingsSection = "general" | "ai" | "data" | "about" | "shortcuts";

export function SettingsView() {
  const [section, setSection] = useState<SettingsSection>("ai");
  const { workspaces, projects, notes, cards } = useCairnStore();

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Settings nav */}
      <nav className="w-44 border-r border-[var(--border)] bg-[var(--surface)] py-4 flex-shrink-0">
        {[
          { id: "general" as const, label: "General", icon: Settings },
          { id: "ai" as const, label: "AI & Chat", icon: Bot },
          { id: "shortcuts" as const, label: "Shortcuts", icon: Keyboard },
          { id: "data" as const, label: "Data", icon: Database },
          { id: "about" as const, label: "About", icon: Info },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setSection(id)}
            className={cn(
              "flex items-center gap-2.5 w-full px-4 py-2 text-xs transition-colors text-left",
              section === id
                ? "text-[var(--text-primary)] bg-[var(--surface-2)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
            )}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-8 space-y-8 animate-fade-in">
          {section === "general" && <GeneralSettings />}
          {section === "ai" && <AISettings />}
          {section === "shortcuts" && <ShortcutsSettings />}
          {section === "data" && (
            <DataSettings
              stats={{
                workspaces: workspaces.length,
                projects: projects.length,
                notes: notes.length,
                cards: cards.length,
              }}
            />
          )}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}

// ── Layout helpers ────────────────────────────

function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
        {description && (
          <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{description}</p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-[var(--border-subtle)]">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--text-secondary)]">{label}</div>
        {description && (
          <div className="text-xs text-[var(--text-tertiary)] mt-0.5 leading-relaxed">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

// ── Toggle switch ─────────────────────────────

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
        checked ? "bg-[var(--accent)]" : "bg-[var(--surface-3)] border border-[var(--border)]"
      )}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-4.5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

// ── General settings ──────────────────────────

function GeneralSettings() {
  const { workspaces } = useCairnStore();
  const workspace = workspaces[0];

  return (
    <SettingsGroup title="General" description="Basic app preferences">
      <SettingsRow label="Workspace name" description="Name shown in the sidebar">
        <Input defaultValue={workspace?.name ?? "Personal"} className="w-48 text-xs" />
      </SettingsRow>
      <SettingsRow label="Theme" description="Cairn is dark mode by default">
        <div className="flex gap-2">
          <button className="px-3 py-1.5 text-xs rounded-md bg-[var(--surface-3)] border border-[var(--accent)] text-[var(--accent)]">
            Dark
          </button>
          <button className="px-3 py-1.5 text-xs rounded-md border border-[var(--border)] text-[var(--text-tertiary)] opacity-50 cursor-not-allowed" disabled>
            Light (soon)
          </button>
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}

// ── AI & Chat settings ────────────────────────

type TestState = "idle" | "testing" | "ok" | "error";

function AISettings() {
  const { aiConfig, setAIConfig } = useCairnStore();
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [testError, setTestError] = useState("");
  const [mcpTestState, setMcpTestState] = useState<TestState>("idle");

  // Available models fetched from the endpoint
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsFetched, setModelsFetched] = useState(false); // track whether we've tried

  // Always read directly from the store — no local shadow copy
  const { baseUrl, model, apiKey, mcpEnabled } = aiConfig;
  const isLocal =
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("0.0.0.0");

  // Immediately persist any field change to the store
  function update(patch: Partial<typeof aiConfig>) {
    setAIConfig(patch);
    // Reset model list when endpoint changes
    if (patch.baseUrl !== undefined) {
      setAvailableModels([]);
      setModelsFetched(false);
    }
  }

  async function fetchModels() {
    setModelsLoading(true);
    setModelsFetched(true);
    try {
      const url = (baseUrl || "https://api.openai.com").replace(/\/$/, "");
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const res = await fetch(`${url}/v1/models`, { headers });
      if (!res.ok) throw new Error(`${res.status}`);

      const data = await res.json();
      // OpenAI returns { data: [{id, ...}] }; Ollama returns the same schema
      const ids: string[] = (data?.data ?? [])
        .map((m: { id: string }) => m.id)
        .filter((id: string) => {
          // Only show chat-capable models — filter out embeddings, whisper, etc.
          return !id.includes("embed") && !id.includes("whisper") && !id.includes("tts") && !id.includes("dall-e");
        })
        .sort();

      setAvailableModels(ids);
      setTestState("ok");
    } catch (err) {
      setTestState("error");
      setTestError(err instanceof Error ? err.message : "Failed to fetch models");
      setAvailableModels([]);
    } finally {
      setModelsLoading(false);
      setTimeout(() => setTestState((s) => (s !== "idle" ? "idle" : "idle")), 5000);
    }
  }

  async function testMCP() {
    setMcpTestState("testing");
    try {
      const res = await fetch("/api/mcp?enabled=true", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cairn-mcp-enabled": "true",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "cairn-settings-test", version: "1.0.0" },
          },
        }),
      });
      setMcpTestState(res.ok ? "ok" : "error");
    } catch {
      setMcpTestState("error");
    }
    setTimeout(() => setMcpTestState("idle"), 5000);
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";

  // Fallback preset models when we haven't fetched from the endpoint yet
  const fallbackModels = isLocal
    ? ["llama3.2", "llama3.1", "qwen2.5:14b", "mistral", "phi4", "gemma3:12b"]
    : ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-4", "o1-mini", "o3-mini"];

  const modelOptions = availableModels.length > 0 ? availableModels : fallbackModels;

  return (
    <div className="space-y-8">
      {/* ── Endpoint config ── */}
      <SettingsGroup
        title="AI Endpoint"
        description="Connect to OpenAI, a local Ollama/LM Studio server, or any OpenAI-compatible API. Changes take effect immediately."
      >
        {/* Base URL */}
        <SettingsRow
          label="Base URL"
          description="Root URL. The chat route appends /v1/chat/completions."
        >
          <div className="flex flex-col gap-1.5 items-end">
            <div className="relative">
              <Globe size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => update({ baseUrl: e.target.value })}
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
                  onClick={() => update({ baseUrl: url })}
                  className={cn(
                    "px-2 py-1 text-[10px] rounded border transition-colors",
                    baseUrl === url
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
            isLocal
              ? "Local servers don't need a key — leave blank."
              : "Required for OpenAI. Leave blank to use the OPENAI_API_KEY server env var."
          }
        >
          <div className="relative">
            <Key size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => update({ apiKey: e.target.value })}
              placeholder={isLocal ? "optional" : "sk-…"}
              className="pl-7 pr-8 py-1.5 text-xs w-52 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
            />
            <Tooltip content={showKey ? "Hide API key" : "Show API key"} side="top">
              <button
                onClick={() => setShowKey((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
              >
                {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
            </Tooltip>
          </div>
        </SettingsRow>

        {/* Model + fetch */}
        <SettingsRow
          label="Model"
          description={
            availableModels.length > 0
              ? `${availableModels.length} models loaded from endpoint`
              : "Type a model name or fetch the list from your endpoint."
          }
        >
          <div className="flex flex-col gap-1.5 items-end w-64">
            {/* Text input */}
            <div className="flex gap-1.5 w-full">
              <div className="relative flex-1">
                <Cpu size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                <input
                  type="text"
                  value={model}
                  onChange={(e) => update({ model: e.target.value })}
                  placeholder="gpt-4o-mini"
                  className="pl-7 pr-3 py-1.5 text-xs w-full rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
              <button
                onClick={fetchModels}
                disabled={modelsLoading}
                title="Fetch models from endpoint"
                className={cn(
                  "px-2 py-1.5 text-[10px] rounded-md border transition-colors flex items-center gap-1",
                  "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]",
                  modelsLoading && "opacity-50 cursor-wait"
                )}
              >
                <RefreshCw size={11} className={modelsLoading ? "animate-spin" : ""} />
                {modelsLoading ? "" : "Fetch"}
              </button>
            </div>

            {/* Status line */}
            {testState === "error" && (
              <p className="text-[11px] text-red-400 self-start" title={testError}>
                {testError.slice(0, 60)}
              </p>
            )}
            {testState === "ok" && availableModels.length > 0 && (
              <p className="text-[11px] text-[var(--success)] self-start flex items-center gap-1">
                <CheckCircle size={10} /> {availableModels.length} models available
              </p>
            )}

            {/* Model chips — scrollable list */}
            <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto w-full pr-0.5">
              {modelOptions.map((m) => (
                <button
                  key={m}
                  onClick={() => update({ model: m })}
                  className={cn(
                    "px-2 py-0.5 text-[10px] rounded border transition-colors font-mono whitespace-nowrap",
                    model === m
                      ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                      : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
                  )}
                >
                  {m}
                </button>
              ))}
              {modelsFetched && availableModels.length === 0 && !modelsLoading && testState !== "error" && (
                <span className="text-[11px] text-[var(--text-tertiary)]">No models returned</span>
              )}
            </div>
          </div>
        </SettingsRow>

        {/* Status summary */}
        <div className="flex items-center gap-3 pt-1 text-xs">
          <span className={cn(
            "flex items-center gap-1",
            testState === "ok" ? "text-[var(--success)]" : testState === "error" ? "text-red-400" : "text-[var(--text-tertiary)]"
          )}>
            {testState === "ok" && <><CheckCircle size={11} /> Connected</>}
            {testState === "error" && <><WifiOff size={11} /> Error</>}
            {(testState === "idle" || testState === "testing") && <><Wifi size={11} /> {testState === "testing" ? "Connecting…" : "Not tested"}</>}
          </span>
          <span className="text-[var(--text-tertiary)]">·</span>
          <span className="text-[var(--text-tertiary)] font-mono truncate max-w-40">{baseUrl.replace(/^https?:\/\//, "")}</span>
          <span className="text-[var(--text-tertiary)]">·</span>
          <span className="text-[var(--text-tertiary)] font-mono">{model || "no model"}</span>
        </div>
      </SettingsGroup>

      {/* ── MCP Server ── */}
      <MCPServerSettings />
    </div>
  );
}

// ── MCP Server Settings ───────────────────────

function MCPServerSettings() {
  const [mcpServerPath, setMcpServerPath] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof window !== "undefined" && (window as any).electron?.mcpServerPath) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electron.mcpServerPath().then((p: string) => setMcpServerPath(p));
    }
  }, []);

  const opencodeConfig = mcpServerPath
    ? JSON.stringify({ mcp: { cairn: { type: "local", command: ["node", mcpServerPath], enabled: true } } }, null, 2)
    : null;

  const claudeConfig = mcpServerPath
    ? JSON.stringify({ cairn: { command: "node", args: [mcpServerPath] } }, null, 2)
    : null;

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  const CopyButton = ({ text, id }: { text: string; id: string }) => (
    <button
      onClick={() => copy(text, id)}
      className="p-1.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors flex-shrink-0"
    >
      {copied === id ? <CheckCircle size={11} className="text-[var(--success)]" /> : <Copy size={11} />}
    </button>
  );

  return (
    <SettingsGroup
      title="MCP Server"
      description="Cairn runs a local MCP server so AI agents (OpenCode, Claude Desktop, etc.) can read and write your data."
    >
      <MCPSyncStatus />

      {/* Config blocks */}
      <div className="flex flex-col gap-3">
        <ConfigBlock
          label="OpenCode"
          hint="opencode.json — project root"
          code={opencodeConfig}
          copyId="opencode"
          copied={copied}
          onCopy={copy}
        />
        <ConfigBlock
          label="Claude Desktop"
          hint='claude_desktop_config.json → "mcpServers"'
          code={claudeConfig}
          copyId="claude"
          copied={copied}
          onCopy={copy}
        />
      </div>

      {/* Tools list */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3.5">
        <div className="text-xs font-medium text-[var(--text-secondary)] mb-2">Available tools</div>
        <div className="grid grid-cols-2 gap-1.5">
          {[
            ["get_cairn_context", "read"],
            ["search_notes", "read"],
            ["search_tasks", "read"],
            ["get_note", "read"],
            ["get_task", "read"],
            ["get_project_summary", "read"],
            ["list_recent_activity", "read"],
            ["create_project", "write"],
            ["create_note", "write"],
            ["update_note", "write"],
            ["create_task", "write"],
            ["update_task_status", "write"],
            ["link_note_to_task", "write"],
            ["delete_note", "delete"],
            ["delete_task", "delete"],
          ].map(([tool, cat]) => (
            <div key={tool} className="flex items-center gap-1.5">
              <span className={cn(
                "w-1.5 h-1.5 rounded-full flex-shrink-0",
                cat === "write" ? "bg-[var(--warning)]" : cat === "delete" ? "bg-red-400" : "bg-[var(--accent)]"
              )} />
              <span className="text-[11px] font-mono text-[var(--text-tertiary)]">{tool}</span>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-[var(--text-tertiary)] mt-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent)] mr-1" />read &nbsp;
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--warning)] mr-1" />write &nbsp;
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400 mr-1" />delete
        </p>
      </div>
    </SettingsGroup>
  );
}

// ── MCP Config Block ──────────────────────────

function ConfigBlock({
  label, hint, code, copyId, copied, onCopy,
}: {
  label: string;
  hint: string;
  code: string | null;
  copyId: string;
  copied: string | null;
  onCopy: (text: string, id: string) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--surface-2)]">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[var(--text-primary)]">{label}</span>
          <span className="text-[10px] text-[var(--text-tertiary)]">{hint}</span>
        </div>
        {code && (
          <button
            onClick={() => onCopy(code, copyId)}
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors"
          >
            {copied === copyId
              ? <><CheckCircle size={11} className="text-[var(--success)]" /> Copied</>
              : <><Copy size={11} /> Copy</>
            }
          </button>
        )}
      </div>
      {/* Code */}
      <pre className="text-[11px] font-mono text-[var(--text-secondary)] leading-relaxed px-4 py-3 overflow-x-auto">
        {code ?? "Launch Cairn to resolve path…"}
      </pre>
    </div>
  );
}

// ── MCP Sync Status ───────────────────────────

function MCPSyncStatus() {
  const { workspaces, projects, notes, cards } = useCairnStore();

  // Counts come straight from the live Zustand store — no HTTP polling needed.
  // The store is already kept in sync via db:changed IPC whenever MCP writes to SQLite.
  const counts = {
    workspaces: workspaces.length,
    projects: projects.length,
    notes: notes.length,
    cards: cards.length,
  };
  const hasData = workspaces.length > 0;

  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-2 rounded-lg text-xs border",
      hasData
        ? "bg-emerald-500/5 border-emerald-500/20 text-[var(--success)]"
        : "bg-amber-500/5 border-amber-500/20 text-amber-400"
    )}>
      <span className={cn(
        "w-1.5 h-1.5 rounded-full flex-shrink-0",
        hasData ? "bg-[var(--success)] animate-pulse" : "bg-amber-400"
      )} />
      {hasData ? (
        <span>
          SQLite — {counts.workspaces}W · {counts.projects}P · {counts.notes}N · {counts.cards}C
        </span>
      ) : (
        <span>No data yet — open the Cairn app first</span>
      )}
    </div>
  );
}

// ── MCP Project Config ────────────────────────

function MCPProjectConfig({ origin }: { origin: string }) {
  const { projects, workspaces, activeProjectId } = useCairnStore();
  const [selectedId, setSelectedId] = useState<string>(activeProjectId ?? projects[0]?.id ?? "");
  const [copied, setCopied] = useState<string | null>(null);

  const project = projects.find((p) => p.id === selectedId);
  const workspace = workspaces.find((w) => w.id === project?.workspaceId);

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  function CopyBtn({ text, id }: { text: string; id: string }) {
    return (
      <button
        onClick={() => copy(text, id)}
        className="p-1.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors flex-shrink-0"
        title="Copy"
      >
        {copied === id
          ? <CheckCircle size={11} className="text-[var(--success)]" />
          : <Copy size={11} />}
      </button>
    );
  }

  if (!project) return null;

  const mcpUrl = `${origin}/api/mcp?enabled=true`;

  // Claude Desktop snippet — with instructions to scope to this project
  const claudeSnippet = `"cairn-${project.name.toLowerCase().replace(/\s+/g, "-")}": {
  "url": "${mcpUrl}",
  "type": "http"
}`;

  // System prompt insert — tells Claude about the project context
  const systemPrompt = `You have access to the Cairn workspace via MCP tools.
Active project: "${project.name}" (id: ${project.id})
Workspace: "${workspace?.name ?? "Personal"}" (id: ${project.workspaceId})

When using Cairn tools, default to projectId="${project.id}" and workspaceId="${project.workspaceId}" unless the user specifies otherwise.`;

  // Cursor / VS Code MCP settings.json snippet
  const cursorSnippet = `{
  "mcpServers": {
    "cairn": {
      "url": "${mcpUrl}",
      "type": "http"
    }
  }
}`;

  // Raw project context as JSON — useful for pasting into any agent setup
  const projectJson = JSON.stringify(
    {
      projectId: project.id,
      projectName: project.name,
      workspaceId: project.workspaceId,
      workspaceName: workspace?.name,
      mcpUrl,
    },
    null,
    2
  );

  return (
    <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div>
          <div className="text-xs font-semibold text-[var(--text-primary)]">Project context</div>
          <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
            Config snippets scoped to a specific project
          </div>
        </div>
        {/* Project selector */}
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] px-2 py-1.5 focus:outline-none focus:border-[var(--accent)] max-w-40 truncate"
        >
          {projects
            .filter((p) => !p.archivedAt)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.icon ? `${p.icon} ` : ""}{p.name}
              </option>
            ))}
        </select>
      </div>

      {/* Snippets */}
      <div className="divide-y divide-[var(--border)]">
        {/* System prompt */}
        <SnippetRow
          label="System prompt"
          description="Paste into your agent's system prompt to pre-scope all tool calls to this project."
          snippet={systemPrompt}
          onCopy={() => copy(systemPrompt, "system")}
          copied={copied === "system"}
          mono
        />

        {/* Claude Desktop config */}
        <SnippetRow
          label="Claude Desktop"
          description='Add to claude_desktop_config.json → "mcpServers".'
          snippet={claudeSnippet}
          onCopy={() => copy(claudeSnippet, "claude")}
          copied={copied === "claude"}
          mono
        />

        {/* Cursor / VS Code */}
        <SnippetRow
          label="Cursor / VS Code"
          description="Add to .cursor/mcp.json or VS Code MCP settings."
          snippet={cursorSnippet}
          onCopy={() => copy(cursorSnippet, "cursor")}
          copied={copied === "cursor"}
          mono
        />

        {/* Raw context */}
        <SnippetRow
          label="Project IDs"
          description="Raw project and workspace IDs — useful for custom integrations."
          snippet={projectJson}
          onCopy={() => copy(projectJson, "ids")}
          copied={copied === "ids"}
          mono
        />
      </div>
    </div>
  );
}

function SnippetRow({
  label,
  description,
  snippet,
  onCopy,
  copied,
  mono = false,
}: {
  label: string;
  description: string;
  snippet: string;
  onCopy: () => void;
  copied: boolean;
  mono?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = snippet.split("\n");
  const preview = lines.slice(0, 2).join("\n") + (lines.length > 2 ? "\n…" : "");

  return (
    <div className="px-4 py-3 group">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-xs font-medium text-[var(--text-secondary)]">{label}</span>
            <span className="text-[10px] text-[var(--text-tertiary)]">— {description}</span>
          </div>
          <pre
            className={cn(
              "text-[10px] rounded-md bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-words leading-relaxed",
              mono ? "font-mono" : "font-sans",
              "text-[var(--text-tertiary)]",
              !expanded && "max-h-14 overflow-hidden"
            )}
          >
            {expanded ? snippet : preview}
          </pre>
          {lines.length > 2 && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="text-[10px] text-[var(--accent)] hover:underline mt-1"
            >
              {expanded ? "Show less" : `Show all (${lines.length} lines)`}
            </button>
          )}
        </div>
        <button
          onClick={onCopy}
          className={cn(
            "mt-5 p-1.5 rounded flex-shrink-0 transition-colors",
            copied
              ? "text-[var(--success)]"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
          )}
          title="Copy"
        >
          {copied ? <CheckCircle size={13} /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}

// ── Shortcuts ─────────────────────────────────

function ShortcutsSettings() {
  const shortcuts = [
    { key: "⌘K", action: "Open search" },
    { key: "⌘/", action: "Toggle AI chat" },
    { key: "⌘N", action: "New note" },
    { key: "⌘\\", action: "Toggle sidebar" },
    { key: "⌘1", action: "Project overview" },
    { key: "⌘2", action: "Notes view" },
    { key: "⌘3", action: "Board view" },
    { key: "Esc", action: "Close modal / search" },
    { key: "↑↓", action: "Navigate search results" },
    { key: "↵", action: "Open selected result" },
  ];

  return (
    <SettingsGroup title="Keyboard Shortcuts">
      <div className="border border-[var(--border)] rounded-lg overflow-hidden">
        {shortcuts.map(({ key, action }, i) => (
          <div
            key={key}
            className={cn(
              "flex items-center justify-between px-4 py-2.5",
              i > 0 && "border-t border-[var(--border-subtle)]"
            )}
          >
            <span className="text-xs text-[var(--text-secondary)]">{action}</span>
            <kbd className="text-[11px] font-mono bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-0.5 text-[var(--text-tertiary)]">
              {key}
            </kbd>
          </div>
        ))}
      </div>
    </SettingsGroup>
  );
}

// ── Data settings ─────────────────────────────

function DataSettings({
  stats,
}: {
  stats: { workspaces: number; projects: number; notes: number; cards: number };
}) {
  const [exportDone, setExportDone] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  function handleExport() {
    const saved = localStorage.getItem("cairn:v1:state");
    if (!saved) return;
    const blob = new Blob([saved], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cairn-data.json";
    a.click();
    URL.revokeObjectURL(url);
    setExportDone(true);
    setTimeout(() => setExportDone(false), 3000);
  }

  function handleReset() {
    storage.clear();
    window.location.reload();
  }

  return (
    <SettingsGroup title="Data" description="Manage your local Cairn data">
      <div className="grid grid-cols-4 gap-3 mb-2">
        {Object.entries(stats).map(([label, count]) => (
          <div
            key={label}
            className="p-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-center"
          >
            <div className="text-xl font-bold text-[var(--text-primary)]">{count}</div>
            <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      <SettingsRow label="Storage" description="All data is stored locally in SQLite">
        <span className="text-xs text-[var(--text-tertiary)]">SQLite</span>
      </SettingsRow>

      <SettingsRow label="Export data" description="Download your data as cairn-data.json">
        <Button variant="default" size="sm" onClick={handleExport}>
          {exportDone ? (
            <><CheckCircle size={12} className="text-[var(--success)]" /> Exported</>
          ) : (
            <><Download size={12} /> Export</>
          )}
        </Button>
      </SettingsRow>

      <SettingsRow label="Reset data" description="Wipe all local data. Cannot be undone.">
        <Button variant="danger" size="sm" onClick={() => setResetOpen(true)}>
          <Trash2 size={12} /> Reset
        </Button>
      </SettingsRow>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Reset all data?</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              This will wipe all local data including notes, tasks, and projects. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">Cancel</Button>
              </DialogClose>
              <Button variant="danger" size="sm" onClick={handleReset}>
                <Trash2 size={12} /> Wipe all data
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}

// ── About ─────────────────────────────────────

function AboutSection() {
  return (
    <SettingsGroup title="About Cairn">
      <div className="space-y-4 text-sm text-[var(--text-secondary)]">
        <div className="p-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] flex flex-col items-center text-center gap-3">
          <img src="/Cairn_No_BG.png" alt="Cairn" className="w-20 h-20 object-contain" />
          <div>
            <div className="text-base font-semibold text-[var(--text-primary)]">Cairn</div>
            <div className="text-xs text-[var(--text-tertiary)] mt-0.5">v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0"}</div>
          </div>
          <p className="text-xs leading-relaxed max-w-xs">
            Local-first notes and kanban in one place. Notes are saved as Markdown files in a folder you choose; project and task data lives in SQLite alongside them. No accounts, no cloud. An embedded MCP server lets AI agents read and write your workspace directly.
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Stack</div>
          <div className="grid grid-cols-2 gap-2">
            {[
              ["Electron 41", "Desktop shell"],
              ["Next.js 16", "UI framework"],
              ["React 19", "Renderer"],
              ["TypeScript", "Language"],
              ["Tailwind CSS v4", "Styling"],
              ["better-sqlite3", "Local database"],
              ["gray-matter", "Note frontmatter"],
              ["chokidar", "File watcher"],
              ["Zustand", "State"],
              ["dnd-kit", "Drag & drop"],
              ["Lucide", "Icons"],
              ["MCP SDK", "Agent protocol"],
              ["esbuild", "Bundler"],
            ].map(([tech, role]) => (
              <div
                key={tech}
                className="flex items-center justify-between px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
              >
                <span className="text-xs font-medium text-[var(--text-primary)]">{tech}</span>
                <span className="text-[11px] text-[var(--text-tertiary)]">{role}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </SettingsGroup>
  );
}
