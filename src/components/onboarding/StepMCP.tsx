"use client";

import { useState, useEffect } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Shell, NavRow, MCP_AGENTS, type McpAgentId } from "./shared";
import { isElectron } from "@/store/ipc";

interface Props {
  onBack: () => void;
  onNext: () => void;
}

export function StepMCP({ onBack, onNext }: Props) {
  const [selectedAgent, setSelectedAgent] = useState<McpAgentId>("claude");
  const [copied, setCopied] = useState(false);
  const [mcpBin, setMcpBin] = useState<string | null>(null);

  useEffect(() => {
    if (isElectron() && window.electron) {
      window.electron.mcpServerPath().then(setMcpBin).catch(() => {});
    } else {
      // Web / dev fallback
      setMcpBin("/path/to/cairn-mcp");
    }
  }, []);

  const agentData = MCP_AGENTS.find((a) => a.id === selectedAgent)!;

  function handleCopy() {
    if (!mcpBin) return;
    navigator.clipboard.writeText(agentData.snippet(mcpBin));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Shell step="mcp">
      <div className="w-full max-w-md flex flex-col gap-4">

        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 flex flex-col gap-3">
          <div>
            <p className="text-xs font-medium text-[var(--text-secondary)] mb-0.5">MCP Server</p>
            <p className="text-[0.714rem] text-[var(--text-tertiary)] leading-relaxed">
              Cairn ships a bundled MCP server. Connect your AI coding agent for direct read/write access to your workspace.
            </p>
          </div>

          {/* Agent tabs */}
          <div className="flex flex-wrap gap-1.5">
            {MCP_AGENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => { setSelectedAgent(a.id); setCopied(false); }}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border transition-colors",
                  selectedAgent === a.id
                    ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                    : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--accent)]/40 hover:text-[var(--text-secondary)]"
                )}
              >
                <span className="text-[0.7rem]">{a.icon}</span>
                {a.label}
              </button>
            ))}
          </div>

          {/* File hint */}
          <p className="text-[0.65rem] text-[var(--text-tertiary)] font-mono truncate">
            Add to: {agentData.file}
          </p>

          {/* Snippet + copy button */}
          <div className="relative">
            <pre className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-3 text-[0.65rem] text-[var(--text-secondary)] font-mono overflow-x-auto leading-relaxed whitespace-pre">
              {mcpBin ? agentData.snippet(mcpBin) : "Loading…"}
            </pre>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!mcpBin}
              className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 text-[0.65rem] rounded bg-[var(--surface-3)] border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {copied
                ? <Check size={10} className="text-[var(--success)]" />
                : <Copy size={10} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <NavRow onBack={onBack} onNext={onNext} nextLabel="Save & continue" />
      </div>
    </Shell>
  );
}
