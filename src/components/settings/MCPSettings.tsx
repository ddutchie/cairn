"use client";

import React, { useState, useEffect } from "react";
import { CheckCircle, Copy } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./shared";
import { useAgentPreviews } from "./tools/useAgentPreviews";
import { SurfaceToolsPanel, ToolsLegend } from "./tools/preview-components";

// ── MCP tab (AI section) ────────────────────────────────────────────────────
// Server config + sync status + the tools external agents see, in the same
// card style as the Chat and Coding Agents tabs.

export function McpSettingsTab() {
  const previews = useAgentPreviews();
  const mcpTools = previews.inventory?.mcp ?? [];

  return (
    <div className="space-y-8">
      <MCPServerSettings />
      <SettingsGroup
        title="MCP Tools"
        description="The tools external AI agents (OpenCode, Claude Desktop, etc.) can call through the local MCP server. Chat-only tools are not advertised here."
      >
        {previews.inventory ? (
          <div className="space-y-3">
            <SurfaceToolsPanel
              tools={mcpTools}
              footnote="External clients get the broader surface — including get_cairn_context for fresh sessions."
            />
            <ToolsLegend />
          </div>
        ) : (
          !previews.loading && (
            <p className="text-[0.714rem] text-[var(--text-tertiary)] py-4 text-center border border-dashed border-[var(--border)] rounded-lg">
              Tools unavailable — the engine may still be starting.
            </p>
          )
        )}
      </SettingsGroup>
    </div>
  );
}

// ── MCP Server Settings ───────────────────────

export function MCPServerSettings() {
  const [mcpServerPath, setMcpServerPath] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  const { copiedKey, copy: copyToClipboard } = useCopyToClipboard();

  useEffect(() => {
    if (typeof window !== "undefined" && window.electron) {
      window.electron.mcpServerPath().then((p) => setMcpServerPath(p));
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    copyToClipboard(text, key);
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
          copied={copiedKey}
          onCopy={copy}
        />
        <MCPConfigBlock
          label="Claude Desktop"
          hint='claude_desktop_config.json → "mcpServers"'
          code={claudeConfig}
          copyId="claude"
          copied={copiedKey}
          onCopy={copy}
        />
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

