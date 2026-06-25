"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, GitBranch, GitCommit, ArrowUp, Sparkles, Plus, Minus, File, Check, X, ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import type { ProjectSettings } from "@/types";

// ── Types ───────────────────────────────────────────────────────────────────

interface GitViewProps {
  cwd: string;
}

// Inline types matching the preload's ElectronAPI return shapes
interface GitFileEntry {
  path: string;
  status: string;
}
interface GitStatusData {
  branch: string;
  ahead: string;
  behind: string;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
}
type GitLogData = Array<{
  hash: string;
  author: string;
  date: string;
  subject: string;
}>;

// ── Helpers ─────────────────────────────────────────────────────────────────

function statusLabel(s: string): string {
  if (s === "??") return "untracked";
  if (s === "M ") return "modified";
  if (s === "A ") return "added";
  if (s === "D ") return "deleted";
  if (s === "R ") return "renamed";
  if (s === " M") return "modified";
  if (s === " D") return "deleted";
  return s.trim() || "changed";
}

function statusColor(s: string): string {
  if (s.startsWith("A")) return "var(--success)";
  if (s.startsWith("D")) return "var(--danger)";
  if (s.startsWith("R")) return "var(--accent)";
  if (s.startsWith("?")) return "var(--text-tertiary)";
  return "var(--warning)";
}

// ── GitView ─────────────────────────────────────────────────────────────────

export function GitView({ cwd }: GitViewProps) {
  const { agentConfig } = useCairnStore(useShallow((s) => ({
    agentConfig: s.agentConfig,
  })));

  const [status, setStatus] = useState<GitStatusData | null>(null);
  const [log, setLog] = useState<GitLogData>([]);
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [commitSubject, setCommitSubject] = useState("");
  const [commitBody, setCommitBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expandedSection, setExpandedSection] = useState<"staged" | "unstaged" | "untracked" | null>("unstaged");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!window.electron?.git) return;
    try {
      const s = await window.electron.git.status(cwd);
      setStatus(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  const fetchLog = useCallback(async () => {
    if (!window.electron?.git) return;
    try {
      const entries = await window.electron.git.log(cwd, 15);
      setLog(entries);
    } catch { /* log fetch is best-effort */ }
  }, [cwd]);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchStatus();
    fetchLog();
  }, [fetchStatus, fetchLog]);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(fetchStatus, 10_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refresh, fetchStatus]);

  // Clear commit form after successful commit
  function clearForm() {
    setCommitSubject("");
    setCommitBody("");
  }

  async function handleStage(paths?: string[]) {
    if (!window.electron?.git) return;
    try {
      await window.electron.git.stage(cwd, paths ? { files: paths } : { all: true });
      await fetchStatus();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleUnstage(paths?: string[]) {
    if (!window.electron?.git) return;
    try {
      await window.electron.git.unstage(cwd, paths ? { files: paths } : { all: true });
      await fetchStatus();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleCommit() {
    if (!commitSubject.trim() || !window.electron?.git) return;
    setCommitting(true);
    setError(null);
    try {
      await window.electron.git.commit(
        cwd, commitSubject.trim(),
        commitBody.trim() || undefined,
        true,
      );
      clearForm();
      await fetchStatus();
      await fetchLog();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  async function handlePush() {
    if (!window.electron?.git) return;
    setPushing(true);
    setError(null);
    try {
      await window.electron.git.push(cwd, true);
      await fetchStatus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPushing(false);
    }
  }

  async function handleGenerate() {
    if (!window.electron?.git || !window.electron?.ai) return;
    setGenerating(true);
    setError(null);
    try {
      const diff = await window.electron.git.diff(cwd, true);
      if (!diff) {
        setError("No staged changes to generate a commit message from. Stage some files first.");
        setGenerating(false);
        return;
      }
      const config = {
        baseUrl: agentConfig.baseUrl,
        model: agentConfig.model,
        apiKey: agentConfig.apiKey,
      };
      const msg = await window.electron.ai.generateCommitMessage({ diff, config });
      setCommitSubject(msg.subject);
      setCommitBody(msg.body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  const stagedCount = status?.staged.length ?? 0;
  const unstagedCount = (status?.unstaged.length ?? 0) + (status?.untracked.length ?? 0);
  const hasChanges = stagedCount > 0 || unstagedCount > 0;

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col bg-[var(--surface)]">
      {/* ── Branch bar ──────────────────────────────────────────────────── */}
      {status && (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <GitBranch size={12} className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)] font-mono">{status.branch}</span>
          </div>
          {(Number(status.ahead) > 0 || Number(status.behind) > 0) && (
            <div className="flex items-center gap-2 text-[0.65rem] text-[var(--text-tertiary)]">
              {Number(status.ahead) > 0 && (
                <span className="flex items-center gap-0.5">
                  <ArrowUp size={10} /> {status.ahead}
                </span>
              )}
              {Number(status.behind) > 0 && (
                <span className="flex items-center gap-0.5">
                  <ChevronDown size={10} /> {status.behind}
                </span>
              )}
            </div>
          )}
          <div className="flex-1" />
          <button
            onClick={refresh}
            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      )}

      {/* ── Error banner ────────────────────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-2 bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] border-b border-[var(--border)] flex-shrink-0">
          <X size={11} className="text-[var(--danger)] flex-shrink-0" />
          <span className="text-[0.714rem] text-[var(--danger)] flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
            <X size={11} />
          </button>
        </div>
      )}

      {/* ── Changes list ────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && !status ? (
          <div className="flex items-center justify-center py-16">
            <RefreshCw size={16} className="animate-spin text-[var(--text-tertiary)]" />
          </div>
        ) : !hasChanges ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <GitCommit size={24} className="text-[var(--text-tertiary)] opacity-30 mb-2" />
            <p className="text-xs text-[var(--text-tertiary)]">No changes in working tree</p>
            <p className="text-[0.65rem] text-[var(--text-tertiary)] opacity-60 mt-1">
              Edit files in the codebase to see changes here
            </p>
          </div>
        ) : (
          <div className="py-2">
            {/* Staged */}
            {status && status.staged.length > 0 && (
              <FileSection
                label="Staged"
                count={status.staged.length}
                expanded={expandedSection === "staged"}
                onToggle={() => setExpandedSection(expandedSection === "staged" ? null : "staged")}
                action={
                  <button
                    onClick={() => handleUnstage()}
                    className="text-[0.65rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-2 py-0.5 rounded hover:bg-[var(--surface-3)] transition-colors"
                  >
                    Unstage all
                  </button>
                }
              >
                {status.staged.map((file) => (
                  <FileRow
                    key={file.path}
                    path={file.path}
                    status={file.status}
                    onAction={() => handleUnstage([file.path])}
                    actionLabel="-"
                    actionColor="var(--danger)"
                  />
                ))}
              </FileSection>
            )}

            {/* Unstaged */}
            {status && status.unstaged.length > 0 && (
              <FileSection
                label="Modified"
                count={status.unstaged.length}
                expanded={expandedSection === "unstaged"}
                onToggle={() => setExpandedSection(expandedSection === "unstaged" ? null : "unstaged")}
                action={
                  <button
                    onClick={() => handleStage(status.unstaged.map((f) => f.path))}
                    className="text-[0.65rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-2 py-0.5 rounded hover:bg-[var(--surface-3)] transition-colors"
                  >
                    Stage all
                  </button>
                }
              >
                {status.unstaged.map((file) => (
                  <FileRow
                    key={file.path}
                    path={file.path}
                    status={file.status}
                    onAction={() => handleStage([file.path])}
                    actionLabel="+"
                    actionColor="var(--success)"
                  />
                ))}
              </FileSection>
            )}

            {/* Untracked */}
            {status && status.untracked.length > 0 && (
              <FileSection
                label="Untracked"
                count={status.untracked.length}
                expanded={expandedSection === "untracked"}
                onToggle={() => setExpandedSection(expandedSection === "untracked" ? null : "untracked")}
                action={
                  <button
                    onClick={() => handleStage(status.untracked.map((f) => f.path))}
                    className="text-[0.65rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-2 py-0.5 rounded hover:bg-[var(--surface-3)] transition-colors"
                  >
                    Stage all
                  </button>
                }
              >
                {status.untracked.map((file) => (
                  <FileRow
                    key={file.path}
                    path={file.path}
                    status={file.status}
                    onAction={() => handleStage([file.path])}
                    actionLabel="+"
                    actionColor="var(--success)"
                  />
                ))}
              </FileSection>
            )}
          </div>
        )}

        {/* ── Commit form ────────────────────────────────────────────────── */}
        {stagedCount > 0 && (
          <div className="border-t border-[var(--border)] px-4 py-3 space-y-2 bg-[var(--surface-2)]">
            <input
              value={commitSubject}
              onChange={(e) => setCommitSubject(e.target.value)}
              placeholder="Commit subject (required)"
              className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 font-mono focus:outline-none"
            />
            <textarea
              value={commitBody}
              onChange={(e) => setCommitBody(e.target.value)}
              placeholder="Commit body (optional)"
              rows={3}
              className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 font-mono focus:outline-none resize-y"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleGenerate}
                disabled={generating || stagedCount === 0}
              >
                <Sparkles size={11} className={cn(generating && "animate-pulse")} />
                {generating ? "Generating..." : "Generate"}
              </Button>
              <div className="flex-1" />
              <Button
                size="sm"
                onClick={handleCommit}
                disabled={!commitSubject.trim() || committing}
              >
                {committing ? "Committing..." : "Commit"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handlePush}
                disabled={pushing}
              >
                <ArrowUp size={11} />
                {pushing ? "Pushing..." : "Push"}
              </Button>
            </div>
          </div>
        )}

        {/* ── Recent commits ─────────────────────────────────────────────── */}
        {log.length > 0 && (
          <div className="border-t border-[var(--border)]">
            <div className="px-4 py-2 text-[0.65rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] bg-[var(--surface-2)] border-b border-[var(--border-subtle)]">
              Recent commits
            </div>
            <div className="divide-y divide-[var(--border-subtle)]">
              {log.map((entry) => (
                <div key={entry.hash} className="flex items-start gap-3 px-4 py-2 hover:bg-[var(--surface-2)] transition-colors">
                  <GitCommit size={10} className="mt-1 text-[var(--text-tertiary)] flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[0.714rem] text-[var(--text-primary)] truncate font-mono">{entry.subject}</div>
                    <div className="flex items-center gap-2 text-[0.65rem] text-[var(--text-tertiary)] mt-0.5">
                      <span className="font-mono">{entry.hash}</span>
                      <span>{entry.author}</span>
                      <span>{new Date(entry.date).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function FileSection({
  label, count, expanded, onToggle, action, children,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="flex items-center gap-2 px-4 py-1.5 cursor-pointer hover:bg-[var(--surface-2)] transition-colors select-none"
        onClick={onToggle}
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">{label}</span>
        <span className="text-[0.65rem] text-[var(--text-tertiary)] opacity-60">{count}</span>
        {!expanded && action && <div className="ml-auto">{action}</div>}
      </div>
      {expanded && (
        <>
          <div className="divide-y divide-[var(--border-subtle)]">{children}</div>
          {action && (
            <div className="flex justify-end px-4 py-1 border-b border-[var(--border-subtle)]">
              {action}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FileRow({
  path, status, onAction, actionLabel, actionColor,
}: {
  path: string;
  status: string;
  onAction: () => void;
  actionLabel: string;
  actionColor: string;
}) {
  return (
    <div className="flex items-center gap-2 px-6 py-1.5 hover:bg-[var(--surface-2)] transition-colors group">
      <button
        onClick={onAction}
        className="w-4 h-4 rounded flex items-center justify-center text-[0.65rem] font-bold opacity-0 group-hover:opacity-100 transition-opacity hover:scale-110"
        style={{ color: actionColor, backgroundColor: `${actionColor}15` }}
        title={actionLabel === "+" ? "Stage" : "Unstage"}
      >
        {actionLabel}
      </button>
      <File size={9} className="text-[var(--text-tertiary)] flex-shrink-0 opacity-50" />
      <span className="text-[0.714rem] text-[var(--text-primary)] font-mono truncate flex-1">{path}</span>
      <span
        className="text-[0.65rem] font-mono px-1.5 py-0.5 rounded flex-shrink-0"
        style={{ color: statusColor(status), backgroundColor: `${statusColor(status)}10` }}
      >
        {statusLabel(status)}
      </span>
    </div>
  );
}
