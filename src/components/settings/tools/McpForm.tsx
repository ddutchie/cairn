"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { McpServerConfig } from "@/types";
import { type HeaderRow, headersToRows, inputCls, labelCls } from "./helpers";
import { HeaderEditor } from "./HeaderEditor";

/** Add/edit form for an MCP server (remote http/sse or local stdio). */
export function McpForm({
  initial,
  onSave,
  onCancel,
  dev = false,
}: {
  initial?: McpServerConfig;
  onSave: (s: Partial<McpServerConfig>, headerRows: HeaderRow[]) => void;
  onCancel: () => void;
  /** Dev builds only: show the dsh-path spike toggle (remote only). */
  dev?: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const initialTransport = initial?.transport ?? "http";
  const [transport, setTransport] = useState<"sse" | "http" | "stdio">(initialTransport);
  const isStdio = transport === "stdio";
  const [baseUrl, setBaseUrl] = useState(initial?.transport === "stdio" ? "" : (initial?.baseUrl ?? ""));
  const [authMode, setAuthMode] = useState<"none" | "oauth">(
    initial?.transport === "stdio" ? "none" : (initial?.authMode ?? "none"),
  );
  const [oauthScope, setOauthScope] = useState(initial?.transport === "stdio" ? "" : (initial?.oauthScope ?? ""));
  const [oauthClientId, setOauthClientId] = useState(initial?.transport === "stdio" ? "" : (initial?.oauthClientId ?? ""));
  const [oauthRedirectUri, setOauthRedirectUri] = useState(
    initial?.transport === "stdio" ? "" : (initial?.oauthRedirectUri ?? ""),
  );
  const [oauthClientIdRequired, setOauthClientIdRequired] = useState(
    initial?.transport === "stdio" ? false : (initial?.oauthClientIdRequired ?? false),
  );
  // Remote: headers. Stdio: env (reuses the same key/value editor).
  const [rows, setRows] = useState<HeaderRow[]>(() =>
    headersToRows(isStdio ? (initial as { env?: Record<string, string> } | undefined)?.env : initial?.headers),
  );
  const [command, setCommand] = useState(
    initial?.transport === "stdio" ? (initial.command ?? "") : "",
  );
  const [argsText, setArgsText] = useState(
    initial?.transport === "stdio" ? (initial.args ?? []).join(" ") : "",
  );
  const [cwd, setCwd] = useState(initial?.transport === "stdio" ? (initial.cwd ?? "") : "");
  const [claudeJson, setClaudeJson] = useState("");
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [dshPath, setDshPath] = useState(initial?.dshPath ?? false);

  const valid = isStdio
    ? name.trim().length > 0 && command.trim().length > 0 && (cwd.trim() === "" || cwd.trim().startsWith("/"))
    : name.trim().length > 0 && /^https?:\/\//.test(baseUrl.trim());

  function applyClaudeImport() {
    setClaudeError(null);
    try {
      const parsed = JSON.parse(claudeJson) as { command?: unknown; args?: unknown; env?: unknown };
      if (!parsed || typeof parsed !== "object") throw new Error("must be an object with a command");
      if (typeof parsed.command !== "string" || !parsed.command.trim()) throw new Error("needs a command string");
      setCommand(parsed.command.trim());
      if (parsed.args !== undefined) {
        if (!Array.isArray(parsed.args) || !parsed.args.every((a) => typeof a === "string")) {
          throw new Error("args must be an array of strings");
        }
        setArgsText((parsed.args as string[]).join(" "));
      }
      if (parsed.env !== undefined) {
        if (typeof parsed.env !== "object" || parsed.env === null || Array.isArray(parsed.env)) {
          throw new Error("env must be an object");
        }
        const next: HeaderRow[] = [];
        for (const [k, v] of Object.entries(parsed.env as Record<string, unknown>)) {
          if (typeof v !== "string") throw new Error(`env.${k} must be a string`);
          next.push({ name: k, value: v, isSecret: true });
        }
        setRows(next);
      }
    } catch (err) {
      setClaudeError(err instanceof Error ? err.message : "Invalid JSON");
    }
  }

  function handleSave() {
    if (isStdio) {
      const args = argsText.split(/\s+/).map((a) => a.trim()).filter(Boolean);
      onSave(
        {
          id: initial?.id,
          name: name.trim(),
          description: description.trim() || undefined,
          transport: "stdio",
          command: command.trim(),
          args,
          cwd: cwd.trim() || undefined,
          dshPath: undefined,
          enabled: initial?.enabled ?? false,
          source: initial?.source ?? "manual",
        },
        rows,
      );
      return;
    }
    onSave(
      {
        id: initial?.id,
        name: name.trim(),
        description: description.trim() || undefined,
        baseUrl: baseUrl.trim(),
        transport,
        authMode,
        oauthScope: authMode === "oauth" ? oauthScope.trim() || undefined : undefined,
        oauthClientId: authMode === "oauth" ? oauthClientId.trim() || undefined : undefined,
        oauthRedirectUri: authMode === "oauth" ? oauthRedirectUri.trim() || undefined : undefined,
        oauthClientIdRequired: authMode === "oauth" ? oauthClientIdRequired : undefined,
        dshPath: dev ? dshPath : initial?.dshPath,
        enabled: initial?.enabled ?? false,
        source: initial?.source ?? "manual",
      },
      authMode === "oauth" ? [] : rows,
    );
  }

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
        <label className={labelCls}>Transport</label>
        <div className="inline-flex rounded border border-[var(--border)] overflow-hidden">
          {(["http", "sse", "stdio"] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTransport(t);
                if (t === "stdio") {
                  setRows(headersToRows((initial as { env?: Record<string, string> } | undefined)?.env));
                } else {
                  setRows(headersToRows(initial?.headers));
                }
              }}
              className={cn(
                "px-3 py-1 text-xs transition-colors",
                transport === t ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-3)]",
              )}
            >
              {t === "http" ? "streamable-HTTP" : t === "sse" ? "SSE" : "stdio (local)"}
            </button>
          ))}
        </div>
        {isStdio && (
          <p className="mt-1 text-[0.714rem] text-[var(--text-tertiary)]">
            Runs as a local child process on this machine (desktop only). No shell — command + args spawn directly.
          </p>
        )}
      </div>
      {isStdio ? (
        <div className="space-y-3">
          <div>
            <label className={labelCls}>Command *</label>
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="e.g. npx or /usr/local/bin/my-mcp" className={cn(inputCls, "font-mono")} />
          </div>
          <div>
            <label className={labelCls}>Args (space-separated)</label>
            <input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="e.g. -y @modelcontextprotocol/server-filesystem /tmp" className={cn(inputCls, "font-mono")} />
          </div>
          <div>
            <label className={labelCls}>Working directory (optional, absolute)</label>
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="Defaults to the workspace folder" className={cn(inputCls, "font-mono")} />
          </div>
          <div>
            <label className={labelCls}>Environment</label>
            <HeaderEditor rows={rows} onChange={setRows} />
            <p className="mt-1 text-[0.714rem] text-[var(--text-tertiary)]">
              Values that look like credentials are stored in the OS keychain, never in the database.
            </p>
          </div>
          <div>
            <label className={labelCls}>Paste Claude Desktop entry (optional)</label>
            <textarea
              value={claudeJson}
              onChange={(e) => setClaudeJson(e.target.value)}
              placeholder='{"command": "npx", "args": ["-y", "pkg"], "env": {"KEY": "…"}}'
              rows={3}
              className={cn(inputCls, "font-mono")}
            />
            {claudeError && <p className="mt-1 text-[0.714rem] text-[var(--accent)]">{claudeError}</p>}
            <div className="mt-1 flex justify-end">
              <Button variant="ghost" size="sm" disabled={!claudeJson.trim()} onClick={applyClaudeImport}>
                Fill from JSON
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div>
            <label className={labelCls}>Base URL *</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://mcp.example.com/sse" className={cn(inputCls, "font-mono")} />
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
                    authMode === m ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-3)]",
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
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={oauthClientIdRequired}
                  onChange={(e) => setOauthClientIdRequired(e.target.checked)}
                  className="accent-[var(--accent)]"
                />
                Requires a pre-registered app (provider doesn&apos;t support dynamic registration)
              </label>
              {oauthClientIdRequired && (
                <p className="text-[0.714rem] text-[var(--accent)]">
                  This provider (e.g. Slack) needs the client id + redirect URI of an app you create. Fill both fields below to sign in.
                </p>
              )}
              <div>
                <label className={labelCls}>Scope (optional)</label>
                <input value={oauthScope} onChange={(e) => setOauthScope(e.target.value)} placeholder="e.g. read:tools" className={cn(inputCls, "font-mono")} />
              </div>
              <div>
                <label className={cn(labelCls, oauthClientIdRequired && "text-[var(--accent)]")}>Client ID{oauthClientIdRequired ? " *" : " (optional)"}</label>
                <input value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} placeholder="e.g. 1601185624273.8899143856786" className={cn(inputCls, "font-mono")} />
                <p className="mt-1 text-[0.714rem] text-[var(--text-tertiary)]">The public client id of the app you created. It is not a secret.</p>
              </div>
              <div>
                <label className={cn(labelCls, oauthClientIdRequired && "text-[var(--accent)]")}>Redirect URI{oauthClientIdRequired ? " *" : " (optional)"}</label>
                <input value={oauthRedirectUri} onChange={(e) => setOauthRedirectUri(e.target.value)} placeholder="http://127.0.0.1:48123/callback" className={cn(inputCls, "font-mono")} />
                <p className="mt-1 text-[0.714rem] text-[var(--text-tertiary)]">Register this exact URL in the app&apos;s OAuth settings; the port must be free.</p>
              </div>
            </div>
          ) : (
            <HeaderEditor rows={rows} onChange={setRows} />
          )}
        </>
      )}
      {dev && !isStdio && (
        <label className="flex items-start gap-2 text-xs text-[var(--text-secondary)] cursor-pointer rounded border border-dashed border-[var(--border)] px-2 py-1.5" title="Dev-only: route this server through dsh-mcp-client instead of the hand bridge. Parity is verified per turn with automatic fallback.">
          <input type="checkbox" checked={dshPath} onChange={(e) => setDshPath(e.target.checked)} className="accent-[var(--accent)] mt-0.5" />
          <span>
            Route via dsh <span className="text-[var(--text-tertiary)]">(dev spike — parity-checked per turn, falls back automatically)</span>
          </span>
        </label>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!valid} onClick={handleSave}>
          <Check size={12} /> Save server
        </Button>
      </div>
    </div>
  );
}
