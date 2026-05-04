"use client";

import React, { useState, useEffect, useMemo } from "react";
import { CheckCircle, Copy } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./shared";
import { MCP_TOOLS } from "../../../electron/lib/tool-schemas";

// ── MCP Server Settings ───────────────────────

export function MCPServerSettings() {
  const [mcpServerPath, setMcpServerPath] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.electron) {
      window.electron.mcpServerPath().then((p) => setMcpServerPath(p));
      setPlatform(window.electron.platform ?? null);
    }
  }, []);

  const isWin = platform === "win32";

  // OpenCode: command is an array — passed directly without shell, safe on all platforms.
  const opencodeConfig = mcpServerPath
    ? JSON.stringify({ mcp: { cairn: { type: "local", command: [mcpServerPath], enabled: true } } }, null, 2)
    : null;

  // Claude Desktop: on Windows, paths with spaces break if passed as a bare command string
  // because Claude spawns via cmd.exe which splits on spaces. Use cmd /c to avoid this.
  const claudeConfig = mcpServerPath
    ? isWin
      ? JSON.stringify({ cairn: { command: "cmd", args: ["/c", mcpServerPath] } }, null, 2)
      : JSON.stringify({ cairn: { command: mcpServerPath, args: [] } }, null, 2)
    : null;

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <SettingsGroup
      title="MCP Server"
      description="Cairn runs a local MCP server so AI agents (OpenCode, Claude Desktop, etc.) can read and write your data."
    >
      <MCPSyncStatus />

      {/* Config blocks */}
      <div className="flex flex-col gap-3">
        <MCPConfigBlock
          label="OpenCode"
          hint="opencode.json — project root"
          code={opencodeConfig}
          copyId="opencode"
          copied={copied}
          onCopy={copy}
        />
        <MCPConfigBlock
          label="Claude Desktop"
          hint='claude_desktop_config.json → "mcpServers"'
          code={claudeConfig}
          copyId="claude"
          copied={copied}
          onCopy={copy}
        />
      </div>

      {/* Tools list — derived from MCP_TOOLS, no manual maintenance needed */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3.5">
        <div className="text-xs font-medium text-[var(--text-secondary)] mb-2">Available tools</div>
        <div className="grid grid-cols-2 gap-1.5">
          {MCP_TOOLS.map(({ name, category }) => (
            <div key={name} className="flex items-center gap-1.5">
              <span className={cn(
                "w-1.5 h-1.5 rounded-full flex-shrink-0",
                category === "write" ? "bg-[var(--warning)]" : category === "delete" ? "bg-[var(--danger)]" : "bg-[var(--accent)]"
              )} />
              <span className="text-[0.786rem] font-mono text-[var(--text-tertiary)]">{name}</span>
            </div>
          ))}
        </div>
        <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent)] mr-1" />read &nbsp;
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--warning)] mr-1" />write &nbsp;
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--danger)] mr-1" />delete
        </p>
      </div>

      {/* Project-scoped context snippets */}
      <div>
        <div className="text-xs font-semibold text-[var(--text-secondary)] mb-2">Project context</div>
        <MCPProjectConfig />
      </div>
    </SettingsGroup>
  );
}

// ── MCP Config Block ──────────────────────────

export function MCPConfigBlock({
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
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">{hint}</span>
        </div>
        {code && (
          <button
            onClick={() => onCopy(code, copyId)}
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[0.786rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors"
          >
            {copied === copyId
              ? <><CheckCircle size={11} className="text-[var(--success)]" /> Copied</>
              : <><Copy size={11} /> Copy</>
            }
          </button>
        )}
      </div>
      {/* Code */}
      <pre className="text-[0.786rem] font-mono text-[var(--text-secondary)] leading-relaxed px-4 py-3 overflow-x-auto">
        {code ?? "Launch Cairn to resolve path…"}
      </pre>
    </div>
  );
}

// ── MCP Sync Status ───────────────────────────

export function MCPSyncStatus() {
  const { workspaces, projects, notes, cards } = useCairnStore(useShallow((s) => ({
    workspaces: s.workspaces,
    projects:   s.projects,
    notes:      s.notes,
    cards:      s.cards,
  })));

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
        ? "bg-[var(--success)]/5 border-[var(--success)]/20 text-[var(--success)]"
        : "bg-[var(--warning)]/5 border-[var(--warning)]/20 text-[var(--warning)]"
    )}>
      <span className={cn(
        "w-1.5 h-1.5 rounded-full flex-shrink-0",
        hasData ? "bg-[var(--success)] animate-pulse" : "bg-[var(--warning)]"
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

export function MCPProjectConfig() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const { projects, workspaces, activeProjectId } = useCairnStore(useShallow((s) => ({
    projects:        s.projects,
    workspaces:      s.workspaces,
    activeProjectId: s.activeProjectId,
  })));
  const [selectedId, setSelectedId] = useState<string>(activeProjectId ?? projects[0]?.id ?? "");
  const [copied, setCopied] = useState<string | null>(null);

  const project   = useMemo(() => projects.find((p) => p.id === selectedId),     [projects, selectedId]);
  const workspace = useMemo(() => workspaces.find((w) => w.id === project?.workspaceId), [workspaces, project?.workspaceId]);

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  if (!project) return null;

  const mcpUrl = `${origin}/api/mcp?enabled=true`;

  const claudeSnippet = `"cairn-${project.name.toLowerCase().replace(/\s+/g, "-")}": {\n  "url": "${mcpUrl}",\n  "type": "http"\n}`;

  const systemPrompt = `You have access to the Cairn workspace via MCP tools.\nActive project: "${project.name}" (id: ${project.id})\nWorkspace: "${workspace?.name ?? "Personal"}" (id: ${project.workspaceId})\n\nWhen using Cairn tools, default to projectId="${project.id}" and workspaceId="${project.workspaceId}" unless the user specifies otherwise.`;

  const cursorSnippet = `{\n  "mcpServers": {\n    "cairn": {\n      "url": "${mcpUrl}",\n      "type": "http"\n    }\n  }\n}`;

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
          <div className="text-[0.786rem] text-[var(--text-tertiary)] mt-0.5">
            Config snippets scoped to a specific project
          </div>
        </div>
        {/* Project selector */}
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] px-2 py-1.5 focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)] max-w-40 truncate"
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
        <SnippetRow
          label="System prompt"
          description="Paste into your agent's system prompt to pre-scope all tool calls to this project."
          snippet={systemPrompt}
          onCopy={() => copy(systemPrompt, "system")}
          copied={copied === "system"}
          mono
        />
        <SnippetRow
          label="Claude Desktop"
          description='Add to claude_desktop_config.json → "mcpServers".'
          snippet={claudeSnippet}
          onCopy={() => copy(claudeSnippet, "claude")}
          copied={copied === "claude"}
          mono
        />
        <SnippetRow
          label="Cursor / VS Code"
          description="Add to .cursor/mcp.json or VS Code MCP settings."
          snippet={cursorSnippet}
          onCopy={() => copy(cursorSnippet, "cursor")}
          copied={copied === "cursor"}
          mono
        />
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
            <span className="text-[0.714rem] text-[var(--text-tertiary)]">— {description}</span>
          </div>
          <pre
            className={cn(
              "text-[0.714rem] rounded-md bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-words leading-relaxed",
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
              className="text-[0.714rem] text-[var(--accent)] hover:underline mt-1"
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
