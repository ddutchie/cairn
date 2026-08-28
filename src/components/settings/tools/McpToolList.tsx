"use client";

import { useState, useEffect } from "react";
import { Loader2, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import type { McpServerConfig } from "@/types";

/**
 * Expandable per-tool enable/disable checklist for an MCP server. Lists the
 * server's individual tools (fetched live) with a switch each; toggling off adds
 * the tool to the server's workspace-wide `disabledTools` list so it's hidden
 * from the AI everywhere the server is used.
 */
export function McpToolList({ server }: { server: McpServerConfig }) {
  const [open, setOpen] = useState(false);
  const { state, fetchMcpTools, setMcpToolEnabled } = useCairnStore(
    useShallow((s) => ({
      state: s.mcpTools[server.id],
      fetchMcpTools: s.fetchMcpTools,
      setMcpToolEnabled: s.setMcpToolEnabled,
    }))
  );

  const disabled = new Set(server.disabledTools ?? []);
  const tools = state?.tools ?? [];
  const loading = state?.loading ?? false;

  // Fetch once when first expanded (or if a prior fetch left no data).
  useEffect(() => {
    if (open && !state) void fetchMcpTools(server.id);
  }, [open, state, fetchMcpTools, server.id]);

  const enabledCount = tools.length - tools.filter((t) => disabled.has(t.name)).length;
  const enabledTools = tools.filter((t) => !disabled.has(t.name));
  const estimateTokens = (list: typeof tools) => {
    if (list.length === 0) return 0;
    // Mirrors dsh token-meter estimate: JSON.stringify(tools).length / 4 + overhead per tool
    // Keep client-side and cheap — no gpt-tokenizer in the renderer.
    const jsonLen = JSON.stringify(list).length;
    return Math.ceil(jsonLen / 4) + list.length * 4;
  };
  const totalTokens = estimateTokens(tools);
  const enabledTokens = estimateTokens(enabledTools);
  const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${n}`);
  const tokenLabel = tools.length > 0 ? `~${fmtTokens(enabledTokens)} tokens` + (enabledCount !== tools.length ? ` of ~${fmtTokens(totalTokens)}` : "") : null;
  const isHeavy = enabledTokens > 10000;

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left"
      >
        {open ? <ChevronDown size={12} className="text-[var(--text-tertiary)] shrink-0" /> : <ChevronRight size={12} className="text-[var(--text-tertiary)] shrink-0" />}
        <span className="text-[0.786rem] text-[var(--text-secondary)]">Tools</span>
        <span className="text-[0.714rem] text-[var(--text-tertiary)]">
          {tools.length > 0 ? `${enabledCount} of ${tools.length} enabled` : "manage which tools the AI can use"}
        </span>
        {tokenLabel && (
          <span className={`text-[0.643rem] font-mono px-1.5 py-0.5 rounded-full border ${isHeavy ? "bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_22%,transparent)]" : "bg-[var(--surface)] text-[var(--text-tertiary)] border-[var(--border)]"}`} title={`Estimated prompt tokens for the tool definitions (JSON length / 4 + overhead). Disable tools to reduce context.`}>
            {tokenLabel}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {loading && <Loader2 size={11} className="animate-spin text-[var(--text-tertiary)]" />}
          <span
            role="button"
            tabIndex={0}
            aria-label="Refresh tool list"
            onClick={(e) => { e.stopPropagation(); void fetchMcpTools(server.id); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); void fetchMcpTools(server.id); } }}
            className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
          >
            <RefreshCw size={11} />
          </span>
        </span>
      </button>

      {open && (
        <div className="px-2.5 pb-2 pt-0.5">
          {state?.error ? (
            <p className="text-[0.714rem] text-[var(--danger)] py-1.5">{state.error}</p>
          ) : tools.length === 0 ? (
            <p className="text-[0.714rem] text-[var(--text-tertiary)] py-1.5">
              {loading ? "Loading tools…" : "No tools reported by this server."}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {tools.map((t) => {
                const isEnabled = !disabled.has(t.name);
                const oneTokens = Math.ceil(JSON.stringify(t).length / 4) + 4;
                return (
                  <li key={t.name} className="flex items-start gap-2 py-1">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[0.786rem] text-[var(--text-secondary)] font-mono truncate">{t.name}</span>
                        <span className="text-[0.571rem] font-mono px-1 py-0 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-tertiary)] shrink-0" title="Estimated tokens for this tool's definition">~{fmtTokens(oneTokens)}</span>
                      </div>
                      {t.description && (
                        <div className="text-[0.714rem] text-[var(--text-tertiary)] line-clamp-2">{t.description}</div>
                      )}
                    </div>
                    <button
                      onClick={() => void setMcpToolEnabled(server.id, t.name, !isEnabled)}
                      role="switch"
                      aria-checked={isEnabled}
                      aria-label={`${isEnabled ? "Disable" : "Enable"} ${t.name}`}
                      className={cn(
                        "relative inline-flex h-4 w-7 items-center rounded-full transition-colors flex-shrink-0 mt-0.5",
                        isEnabled ? "bg-[var(--accent)]" : "bg-[var(--surface-3)] border border-[var(--border)]"
                      )}
                    >
                      <span className={cn("inline-block h-3 w-3 rounded-full bg-[var(--surface)] shadow-sm transition-transform", isEnabled ? "translate-x-3.5" : "translate-x-0.5")} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
