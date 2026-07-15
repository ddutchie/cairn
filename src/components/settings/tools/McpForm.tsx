"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { McpServerConfig } from "@/types";
import { type HeaderRow, headersToRows, inputCls, labelCls } from "./helpers";
import { HeaderEditor } from "./HeaderEditor";

/** Add/edit form for an MCP server (name, URL, transport, auth, headers). */
export function McpForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: McpServerConfig;
  onSave: (s: Partial<McpServerConfig>, headerRows: HeaderRow[]) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [transport, setTransport] = useState<"sse" | "http">(initial?.transport ?? "http");
  const [authMode, setAuthMode] = useState<"none" | "oauth">(initial?.authMode ?? "none");
  const [oauthScope, setOauthScope] = useState(initial?.oauthScope ?? "");
  const [rows, setRows] = useState<HeaderRow[]>(headersToRows(initial?.headers));

  const valid = name.trim().length > 0 && /^https?:\/\//.test(baseUrl.trim());

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] p-4 bg-[var(--surface-2)]">
      <div>
        <label className={labelCls}>Name *</label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="e.g. Weather MCP" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this server provides" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Base URL *</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://mcp.example.com/sse" className={cn(inputCls, "font-mono")} />
      </div>
      <div>
        <label className={labelCls}>Transport</label>
        <div className="inline-flex rounded border border-[var(--border)] overflow-hidden">
          {(["http", "sse"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTransport(t)}
              className={cn(
                "px-3 py-1 text-xs transition-colors",
                transport === t ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-3)]"
              )}
            >
              {t === "http" ? "streamable-HTTP" : "SSE"}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className={labelCls}>Authentication</label>
        <div className="inline-flex rounded border border-[var(--border)] overflow-hidden">
          {(["none", "oauth"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setAuthMode(m)}
              className={cn(
                "px-3 py-1 text-xs transition-colors",
                authMode === m ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-3)]"
              )}
            >
              {m === "none" ? "Headers / API key" : "OAuth"}
            </button>
          ))}
        </div>
        {authMode === "oauth" && (
          <p className="mt-1 text-[0.714rem] text-[var(--text-tertiary)]">
            Sign in via your browser after saving. Tokens are stored in your OS keychain.
          </p>
        )}
      </div>
      {authMode === "oauth" ? (
        <div>
          <label className={labelCls}>Scope (optional)</label>
          <input value={oauthScope} onChange={(e) => setOauthScope(e.target.value)} placeholder="e.g. read:tools" className={cn(inputCls, "font-mono")} />
        </div>
      ) : (
        <HeaderEditor rows={rows} onChange={setRows} />
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={!valid} onClick={() => onSave({ id: initial?.id, name: name.trim(), description: description.trim() || undefined, baseUrl: baseUrl.trim(), transport, authMode, oauthScope: authMode === "oauth" ? (oauthScope.trim() || undefined) : undefined, enabled: initial?.enabled ?? false, source: initial?.source ?? "manual" }, authMode === "oauth" ? [] : rows)}>
          <Check size={12} /> Save server
        </Button>
      </div>
    </div>
  );
}
