"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Sparkles, Send, Loader2, Server, Globe, ShieldAlert, X, KeyRound, Check } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { id, cn } from "@/lib/utils";

interface TranscriptItem {
  role: "user" | "assistant" | "step";
  text: string;
}

interface Proposal {
  toolType: "service" | "mcp";
  config: Record<string, unknown>;
}

const inputCls =
  "w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-2 focus:outline-none";

/**
 * AI Tool Builder modal — drives a streaming builder session over
 * window.electron.toolBuilder. The user describes an endpoint; the builder
 * probes it (in the main process), discovers the tool shape, optimizes the
 * response keys, and saves a tool DISABLED for review.
 */
export function ToolBuilderModal({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [sessionId] = useState(() => id());
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [probeHost, setProbeHost] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // User-supplied secret for authed probes. The value is sent to the main
  // process with the next prompt and held only in that session's memory — it is
  // NEVER shown to the model (the LLM only ever writes a <PLACEHOLDER>).
  const [secretHeader, setSecretHeader] = useState("x-api-key");
  const [secretValue, setSecretValue] = useState("");
  const [secretSent, setSecretSent] = useState(false);
  const streamingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Append streamed assistant tokens to the last assistant item (or start one).
  const appendAssistant = useCallback((delta: string) => {
    setTranscript((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant") {
        return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
      }
      return [...prev, { role: "assistant", text: delta }];
    });
  }, []);

  useEffect(() => {
    const tb = window.electron?.toolBuilder;
    if (!tb) return;
    const offs = [
      tb.onToken((e) => {
        if (e.sessionId !== sessionId) return;
        appendAssistant(e.delta);
      }),
      tb.onStep((e) => {
        if (e.sessionId !== sessionId) return;
        const detail = e.args?.url ? ` ${String(e.args.url)}` : "";
        setTranscript((prev) => [...prev, { role: "step", text: `${e.name}${detail}` }]);
      }),
      tb.onProbeHost((e) => {
        if (e.sessionId !== sessionId) return;
        setProbeHost(e.host);
      }),
      tb.onProposal((e) => {
        if (e.sessionId !== sessionId) return;
        setProposal({ toolType: e.toolType, config: e.config as Record<string, unknown> });
      }),
      tb.onDone((e) => {
        if (e.sessionId !== sessionId) return;
        streamingRef.current = false;
        setBusy(false);
        if (e.error) setError(e.error);
      }),
    ];
    return () => {
      offs.forEach((off) => off?.());
      window.electron?.toolBuilder?.end(sessionId);
    };
  }, [sessionId, appendAssistant]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, proposal]);

  const send = useCallback(() => {
    const message = input.trim();
    if (!message || busy) return;
    setError(null);
    setTranscript((prev) => [...prev, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    streamingRef.current = true;
    const header = secretHeader.trim();
    const value = secretValue.trim();
    const secret = header && value ? { header, value } : undefined;
    if (secret) setSecretSent(true);
    window.electron?.toolBuilder?.prompt({ sessionId, workspaceId, message, secret });
  }, [input, busy, sessionId, workspaceId, secretHeader, secretValue]);

  // Abort an in-flight run. Also clears local streaming state in case a `done`
  // event is never delivered (e.g. the run hangs), so the modal can be closed.
  const cancel = useCallback(() => {
    window.electron?.toolBuilder?.abort(sessionId);
    streamingRef.current = false;
    setBusy(false);
  }, [sessionId]);

  return (
    <ModalShell
      onClose={onClose}
      size="lg"
      scrollable
      dismissGuard={() => !streamingRef.current}
      title={<><Sparkles size={14} className="text-[var(--accent)]" /> Build a tool with AI</>}
      description="Describe an API endpoint and the AI will probe it, infer the tool shape, optimize response keys, and save a tool for your review."
      footer={
        <div className="flex w-full items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="e.g. Connect to https://api.example.com/search — I want web results"
            className={cn(inputCls, "flex-1")}
            disabled={busy}
          />
          {busy ? (
            <Button size="sm" variant="outline" onClick={cancel}>
              <X size={13} /> Stop
            </Button>
          ) : (
            <Button size="sm" onClick={send} disabled={!input.trim()}>
              <Send size={13} />
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-3 min-h-[20rem]">
        <SecretInput
          header={secretHeader}
          value={secretValue}
          sent={secretSent}
          disabled={busy}
          onHeaderChange={(h) => { setSecretHeader(h); setSecretSent(false); }}
          onValueChange={(v) => { setSecretValue(v); setSecretSent(false); }}
        />

        {transcript.length === 0 && (
          <div className="text-center text-xs text-[var(--text-tertiary)] py-10 px-4">
            <Sparkles size={20} className="mx-auto mb-3 text-[var(--accent)] opacity-60" />
            Paste an endpoint URL and describe what you want. The builder probes the API live, figures out the
            auth and response shape, and saves a ready-to-enable tool.
          </div>
        )}

        {transcript.map((item, i) => {
          if (item.role === "step") {
            return (
              <div key={i} className="flex items-center gap-2 text-[0.714rem] text-[var(--text-tertiary)] font-mono pl-1">
                <Loader2 size={11} className="opacity-50" /> {item.text}
              </div>
            );
          }
          return (
            <div
              key={i}
              className={cn(
                "text-sm rounded-lg px-3 py-2 max-w-[85%]",
                item.role === "user"
                  ? "ml-auto bg-[var(--accent-dim)] text-[var(--text-primary)]"
                  : "bg-[var(--surface-2)] text-[var(--text-secondary)] whitespace-pre-wrap"
              )}
            >
              {item.text}
            </div>
          );
        })}

        {probeHost && (
          <div className="flex items-center gap-2 text-[0.714rem] text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] rounded px-3 py-1.5">
            <ShieldAlert size={12} /> Probing host: <span className="font-mono">{probeHost}</span>
          </div>
        )}

        {error && (
          <div className="text-[0.714rem] text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] rounded px-3 py-2">
            {error}
          </div>
        )}

        {proposal && <ProposalCard proposal={proposal} />}

        <div ref={bottomRef} />
      </div>
    </ModalShell>
  );
}

/**
 * Optional API-key input. The value is forwarded to the main process with the
 * next prompt (held only in session memory) so the builder can run authenticated
 * probes — the model itself never receives the secret, only a placeholder.
 */
function SecretInput({
  header,
  value,
  sent,
  disabled,
  onHeaderChange,
  onValueChange,
}: {
  header: string;
  value: string;
  sent: boolean;
  disabled: boolean;
  onHeaderChange: (v: string) => void;
  onValueChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!open && !value) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
      >
        <KeyRound size={12} /> Add an API key for authenticated probes (optional)
      </button>
    );
  }

  const placeholderHeader = header || "x-api-key";

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-[0.714rem] font-medium text-[var(--text-secondary)]">
        <KeyRound size={12} className="text-[var(--accent)]" /> API key (optional)
        {value && sent && (
          <span className="flex items-center gap-1 text-[var(--success)] ml-auto">
            <Check size={11} /> sent securely
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={header}
          onChange={(e) => onHeaderChange(e.target.value)}
          placeholder="Header name"
          disabled={disabled}
          className={cn(inputCls, "w-[40%] font-mono text-[0.714rem]")}
        />
        <input
          type="password"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder="Paste your key"
          autoComplete="off"
          disabled={disabled}
          className={cn(inputCls, "flex-1 text-[0.714rem]")}
        />
      </div>
      <p className="text-[0.65rem] text-[var(--text-tertiary)] leading-snug">
        Used only to authenticate live probes during this session. The AI never sees the value — it writes a{" "}
        <span className="font-mono">&lt;API_KEY&gt;</span> placeholder in the{" "}
        <span className="font-mono">{placeholderHeader}</span> header, and the real key is stored in your OS
        keychain when the tool is saved.
      </p>
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const c = proposal.config;
  const isMcp = proposal.toolType === "mcp";
  return (
    <div className="rounded-lg border border-[var(--accent)] bg-[var(--surface)] p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[var(--accent)]">{isMcp ? <Server size={15} /> : <Globe size={15} />}</span>
        <span className="text-sm font-semibold text-[var(--text-primary)]">{String(c.name ?? "Untitled")}</span>
        <span className="text-[0.65rem] px-1.5 py-0.5 rounded-full bg-[var(--accent-dim)] text-[var(--accent)]">
          {isMcp ? "MCP server" : "service"} · saved disabled
        </span>
      </div>
      <div className="text-[0.714rem] text-[var(--text-tertiary)] font-mono break-all">
        {isMcp ? String(c.baseUrl ?? "") : `${String(c.method ?? "GET")} ${String(c.apiUrl ?? "")}`}
      </div>
      {Array.isArray(c.responseKeys) && c.responseKeys.length > 0 && (
        <div className="text-[0.714rem] text-[var(--text-secondary)]">
          <span className="text-[var(--text-tertiary)]">Response keys: </span>
          <span className="font-mono">{(c.responseKeys as string[]).join(", ")}</span>
        </div>
      )}
      <p className="text-[0.714rem] text-[var(--text-tertiary)] pt-1">
        Saved disabled. Review it under the matching section, fill any required secret, then enable and attach it to a project.
      </p>
    </div>
  );
}
