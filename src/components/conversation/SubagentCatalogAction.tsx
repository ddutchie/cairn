"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownRight, GitBranch, Loader2, SendHorizonal, Square } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { Tooltip } from "@/components/ui/tooltip";
import type { SessionProjection } from "@/../shared/agent/session-projection";

type SubagentScope = "children" | "descendants";

interface CatalogChild {
  kind?: string;
  id: string;
  mode?: "one-shot" | "continuable";
  label?: string;
  activity?: "running" | "inactive";
  live?: boolean;
  hasChildren?: boolean;
  reason?: string;
  /** Descendants scope only: durable direct parent + root-relative depth. */
  parentId?: string;
  depth?: number;
}

type CatalogResult =
  | { ok: true; value: { entries: CatalogChild[]; parentAvailable: boolean } }
  | { ok: false; code: string; message: string };

function errorHint(code: string): string {
  switch (code) {
    case "parent-unavailable":
      return "Parent session isn't live — start a turn, then retry.";
    case "not-resumable":
      return "Child can't take messages (finished or expired).";
    case "unauthorized":
      return "Child doesn't belong to this session.";
    case "delivery-unavailable":
      return "Child unavailable right now — retry shortly.";
    case "cancelled":
      return "Delivery was cancelled.";
    default:
      return "Something went wrong — retry.";
  }
}

/**
 * Header action for continuable subagents (dsh 0.1.2 Streamline seam).
 * Lists the session's durable children with live activity, and lets the user
 * message a continuable child or stop its current turn — the human equivalent
 * of the model's send_message / interrupt_agent tools. Lives in the shared
 * ConversationHeader actions slot, so Chat and Coding share one implementation.
 */
export function SubagentCatalogAction({ parentSessionId }: { parentSessionId: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<CatalogChild[]>([]);
  const [parentAvailable, setParentAvailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, string | undefined>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [doneIds, setDoneIds] = useState<Record<string, boolean>>({});
  const [scope, setScope] = useState<SubagentScope>("children");

  // Monotonic request id: a slow list() that resolves after a parent switch
  // (or a newer refresh) must not commit stale entries over the current view.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const parent = parentSessionId;
    const requestedScope = scope;
    if (!parent || !window.electron) return;
    const seq = loadSeq.current + 1;
    loadSeq.current = seq;
    setLoading(true);
    setLoadError(null);
    try {
      const res = (await window.electron.session.listSubagents(parent, requestedScope)) as CatalogResult;
      if (loadSeq.current !== seq || parentSessionId !== parent || scope !== requestedScope) return;
      if (res.ok) {
        setEntries(res.value.entries);
        setParentAvailable(res.value.parentAvailable);
      } else {
        setLoadError(errorHint(res.code));
      }
    } catch {
      if (loadSeq.current !== seq || parentSessionId !== parent || scope !== requestedScope) return;
      setLoadError(errorHint("internal"));
    } finally {
      if (loadSeq.current === seq && parentSessionId === parent && scope === requestedScope) setLoading(false);
    }
  }, [parentSessionId, scope]);

  // Initial + parent-switch load (cheap local IPC; keeps the badge truthful).
  useEffect(() => {
    if (!parentSessionId) return;
    void load(); // eslint-disable-line react-hooks/set-state-in-effect
  }, [parentSessionId, load]);

  // Live updates: child traffic refreshes the list; replies accumulate per row
  // so a messaged cold child (no trace item yet) still shows its answer here.
  useEffect(() => {
    const unsub = window.electron?.session.onProjection((projection: SessionProjection) => {
      if (projection.kind !== "subagent-trace") return;
      if (projection.sessionId !== parentSessionId) return;
      const data = projection.data as Record<string, unknown>;
      if (data.parentSession !== parentSessionId) return;
      const childId = String(data.childId ?? "");
      if (!childId) return;
      if (data.trace === "token" || data.trace === "thought") {
        const delta = String(data.delta ?? "");
        if (delta) setReplies((current) => ({ ...current, [childId]: (current[childId] ?? "") + delta }));
      } else if (data.trace === "status" && data.status === "done") {
        setDoneIds((current) => ({ ...current, [childId]: true }));
      }
      if (data.trace === "status") void load();
    });
    return () => { unsub?.(); };
  }, [load, parentSessionId]);

  const sendMessage = useCallback(async (childId: string) => {
    const parent = parentSessionId;
    const text = (drafts[childId] ?? "").trim();
    if (!parent || !text || busy[childId]) return;
    setBusy((current) => ({ ...current, [childId]: "send" }));
    setRowErrors((current) => ({ ...current, [childId]: "" }));
    try {
      const res = (await window.electron?.session.messageSubagent(parent, childId, text)) as CatalogResult | undefined;
      if (!res) return;
      if (res.ok) {
        setDrafts((current) => ({ ...current, [childId]: "" }));
        setReplies((current) => ({ ...current, [childId]: "" }));
        setDoneIds((current) => ({ ...current, [childId]: false }));
      } else {
        setRowErrors((current) => ({ ...current, [childId]: errorHint(res.code) }));
      }
    } catch {
      setRowErrors((current) => ({ ...current, [childId]: errorHint("internal") }));
    } finally {
      setBusy((current) => ({ ...current, [childId]: undefined }));
    }
  }, [drafts, busy, parentSessionId]);

  const stopChild = useCallback(async (childId: string) => {
    const parent = parentSessionId;
    if (!parent || busy[childId]) return;
    setBusy((current) => ({ ...current, [childId]: "stop" }));
    setRowErrors((current) => ({ ...current, [childId]: "" }));
    try {
      const res = (await window.electron?.session.interruptSubagent(parent, childId)) as CatalogResult | undefined;
      if (res && !res.ok) setRowErrors((current) => ({ ...current, [childId]: errorHint(res.code) }));
    } catch {
      setRowErrors((current) => ({ ...current, [childId]: errorHint("internal") }));
    } finally {
      setBusy((current) => ({ ...current, [childId]: undefined }));
      void load();
    }
  }, [busy, load, parentSessionId]);

  if (!parentSessionId) return null;
  const liveCount = entries.filter((e) => e.kind !== "diagnostic" && e.activity === "running").length;
  // No children yet — nothing to drive. (Traces announce new children live.)
  if (entries.length === 0 && !loading) return null;

  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) void load(); }}>
      <Tooltip content={liveCount > 0 ? `${liveCount} subagent${liveCount === 1 ? "" : "s"} running` : "Subagents"} side="left">
        <Popover.Trigger asChild>
          <button
            className="relative p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
            aria-label="Subagent conversations"
          >
            <GitBranch size={11} />
            {liveCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-3 h-3 px-0.5 rounded-full bg-[var(--accent)] text-[var(--accent-fg)] text-[0.5625rem] leading-3 text-center font-semibold">
                {liveCount}
              </span>
            )}
          </button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 w-80 max-h-96 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl p-2 space-y-2">
          <div className="flex items-center justify-between px-1">
            <p className="text-[0.714rem] font-medium text-[var(--text-secondary)]">Subagents</p>
            <button onClick={() => void load()} className="text-[0.643rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors">
              {loading ? <Loader2 size={10} className="animate-spin" /> : "Refresh"}
            </button>
          </div>
          <div className="flex items-center gap-1.5 px-1" role="group" aria-label="Subagent scope">
            <div className="flex items-center gap-0.5 p-0.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)]">
              {(["children", "descendants"] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => { if (option !== scope) setScope(option); }}
                  aria-pressed={scope === option}
                  title={option === "children" ? "Direct children only" : "Full descendant tree"}
                  className={`px-2 py-0.5 rounded text-[0.643rem] font-medium transition-colors ${scope === option ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"}`}
                >
                  {option === "children" ? "Direct" : "Tree"}
                </button>
              ))}
            </div>
            {scope === "descendants" && (
              <span className="text-[0.5625rem] text-[var(--text-tertiary)]">full tree</span>
            )}
          </div>
          {loadError && <p className="px-1 text-[0.643rem] text-[var(--danger)]">{loadError}</p>}
          {!parentAvailable && entries.length > 0 && (
            <p className="px-1 text-[0.643rem] text-[var(--text-tertiary)]">Parent session isn&apos;t live — messaging is unavailable until its next turn.</p>
          )}
          {entries.map((entry) => {
            if (entry.kind === "diagnostic") {
              return (
                <div key={entry.id} className="px-2 py-1.5 rounded-md border border-[var(--border)] opacity-60">
                  <p className="text-[0.643rem] text-[var(--text-tertiary)]">Unreadable child ({entry.reason})</p>
                </div>
              );
            }
            // Descendants scope: indent nested levels (depth 1 = direct child).
            const depth = typeof entry.depth === "number" && entry.depth > 0 ? entry.depth : 1;
            const nested = depth > 1;
            return (
            <div
              key={entry.id}
              style={nested ? { marginLeft: `${Math.min(depth - 1, 3) * 0.75}rem` } : undefined}
              className="px-2 py-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] space-y-1.5"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                {nested && <CornerDownRight size={10} className="text-[var(--text-tertiary)] shrink-0" />}
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${entry.activity === "running" ? "bg-[var(--success,#22c55e)] animate-pulse" : "bg-[var(--text-tertiary)]"}`} />
                <span className="text-[0.714rem] font-medium text-[var(--text-primary)] truncate flex-1">{entry.label || `${entry.id.slice(0, 8)}…`}</span>
                {nested && entry.parentId && (
                  <span title={`Child of ${entry.parentId}`} className="text-[0.5625rem] text-[var(--text-tertiary)] shrink-0">↳ {entry.parentId.slice(0, 8)}…</span>
                )}
                <span className="text-[0.5625rem] uppercase tracking-wide text-[var(--text-tertiary)] shrink-0">{entry.mode}</span>
              </div>
              {entry.mode === "continuable" && (
                <div className="flex items-center gap-1">
                  <input
                    value={drafts[entry.id] ?? ""}
                    onChange={(e) => setDrafts((current) => ({ ...current, [entry.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(entry.id); } }}
                    placeholder={entry.activity === "running" ? "Message the subagent…" : "Resume with a message…"}
                    disabled={busy[entry.id] !== undefined}
                    className="flex-1 min-w-0 text-[0.714rem] px-2 py-1 rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={() => void sendMessage(entry.id)}
                    disabled={!(drafts[entry.id] ?? "").trim() || busy[entry.id] !== undefined}
                    className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] disabled:opacity-40 transition-colors"
                    aria-label="Send message to subagent"
                  >
                    {busy[entry.id] === "send" ? <Loader2 size={11} className="animate-spin" /> : <SendHorizonal size={11} />}
                  </button>
                  {(entry.activity === "running" || entry.live) && (
                    <button
                      onClick={() => void stopChild(entry.id)}
                      disabled={busy[entry.id] !== undefined}
                      className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--danger)] disabled:opacity-40 transition-colors"
                      aria-label="Stop subagent turn"
                    >
                      {busy[entry.id] === "stop" ? <Loader2 size={11} className="animate-spin" /> : <Square size={11} />}
                    </button>
                  )}
                </div>
              )}
              {rowErrors[entry.id] && <p className="text-[0.643rem] text-[var(--danger)]">{rowErrors[entry.id]}</p>}
              {replies[entry.id] && (
                <p className="text-[0.714rem] text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                  {replies[entry.id]}
                  {doneIds[entry.id] ? "" : "▍"}
                </p>
              )}
            </div>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
