"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { RefreshCw, GitBranch, GitCommit, ArrowUp, Sparkles, Check, X, ChevronDown, GitPullRequest } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { CairnEvents } from "@/lib/events";
import type { ProjectSettings } from "@/types";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import {
  type GitStatusData,
  type GitLogData,
  diffKey,
} from "./git/git-helpers";
import { FileSection } from "./git/FileSection";
import { FileRow } from "./git/FileRow";

// ── Types ───────────────────────────────────────────────────────────────────

interface GitViewProps {
  cwd: string;
}

// ── GitView ─────────────────────────────────────────────────────────────────

export function GitView({ cwd }: GitViewProps) {
  const { agentConfig, activeProjectId, projects } = useCairnStore(useShallow((s) => ({
    agentConfig: s.agentConfig,
    activeProjectId: s.activeProjectId,
    projects: s.projects,
  })));

  const [status, setStatus] = useState<GitStatusData | null>(null);
  const [log, setLog] = useState<GitLogData>([]);
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generatingPrDesc, setGeneratingPrDesc] = useState(false);
  const [prStatus, setPrStatus] = useState<{ url: string | null; state: string | null; title: string | null } | null>(null);
  const [commitSubject, setCommitSubject] = useState("");
  const [commitBody, setCommitBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    staged: false,
    unstaged: true,
    untracked: true,
  });
  const toggleSection = useCallback((section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  }, []);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [fileDiffs, setFileDiffs] = useState<Record<string, { added: number; deleted: number; diff: string }>>({});
  const [loadingFile, setLoadingFile] = useState<string | null>(null);

  const [creatingPr, setCreatingPr] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [showPrForm, setShowPrForm] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevHasUnstagedRef = useRef<boolean | null>(null);
  const prevStagedCountRef = useRef<number | null>(null);
  // Signature of the working-tree file set (path+status across all sections).
  // When it changes between status polls we notify the FileTree to refresh so
  // externally added/removed files appear without a manual refresh.
  const prevFileSigRef = useRef<string | null>(null);

  // Branch switcher states
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean }>>([]);
  const [branchSearch, setBranchSearch] = useState("");
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");

  const fetchStatus = useCallback(async () => {
    if (!window.electron?.git) return;
    try {
      const s = await window.electron.git.status(cwd);
      setStatus(s);
      setError(null);
      // Notify the FileTree only when the working-tree file SET changes (a path
      // added/removed/renamed), not when an existing path merely changes status
      // (e.g. staged ↔ unstaged) — that doesn't alter the directory listing.
      const sig = [...s.staged, ...s.unstaged, ...s.untracked]
        .map((f) => f.path)
        .sort()
        .join("|");
      if (prevFileSigRef.current !== null && prevFileSigRef.current !== sig) {
        window.dispatchEvent(CairnEvents.agentFilesChanged());
      }
      prevFileSigRef.current = sig;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  const fetchBranches = useCallback(async () => {
    if (!window.electron?.git) return;
    try {
      const res = await window.electron.git.branches(cwd);
      setBranches(res.branches);
    } catch { /* best-effort */ }
  }, [cwd]);

  const fetchLog = useCallback(async () => {
    if (!window.electron?.git) return;
    try {
      const entries = await window.electron.git.log(cwd, 15);
      setLog(entries);
    } catch { /* log fetch is best-effort */ }
  }, [cwd]);

  const fetchPrStatus = useCallback(async () => {
    if (!window.electron?.git) return;
    try {
      const status = await window.electron.git.prStatus(cwd);
      setPrStatus(status);
    } catch {
      setPrStatus(null);
    }
  }, [cwd]);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchStatus();
    fetchLog();
    fetchPrStatus();
    fetchBranches();
  }, [fetchStatus, fetchLog, fetchPrStatus, fetchBranches]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    pollRef.current = setInterval(fetchStatus, 10_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refresh, fetchStatus]);

  // Auto-expand the staged section when there are staged files but nothing
  // unstaged/untracked — otherwise the user sees an empty unstaged section
  // and has to manually expand "Staged" to find their changes.
  useEffect(() => {
    if (!status) return;
    const hasUnstaged = status.unstaged.length > 0 || status.untracked.length > 0;
    const stagedCount = status.staged.length;

    // Transition condition: staged count became > 0, and unstaged count became 0
    const transitionToAllStaged =
      stagedCount > 0 &&
      !hasUnstaged &&
      (prevHasUnstagedRef.current === true || prevStagedCountRef.current === 0);

    // Initial load condition: first time we get status, staged > 0, unstaged is 0
    const isInitialLoadAllStaged =
      prevHasUnstagedRef.current === null &&
      stagedCount > 0 &&
      !hasUnstaged;

    if (transitionToAllStaged || isInitialLoadAllStaged) {
      setExpandedSections((prev) => ({ ...prev, staged: true }));
    }

    prevHasUnstagedRef.current = hasUnstaged;
    prevStagedCountRef.current = stagedCount;
  }, [status]);

  const handleCheckout = useCallback(async (branch: string, create = false): Promise<boolean> => {
    if (!window.electron?.git) return false;
    setLoading(true);
    setError(null);
    try {
      await window.electron.git.checkout(cwd, branch, create);
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  }, [cwd, refresh]);

  const handleCreateBranch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBranchName.trim()) return;
    const success = await handleCheckout(newBranchName.trim(), true);
    if (success) {
      setNewBranchOpen(false);
      setNewBranchName("");
    }
  }, [newBranchName, handleCheckout]);

  // Clear commit form after successful commit
  function clearForm() {
    setCommitSubject("");
    setCommitBody("");
  }

  async function handleStage(paths?: string[]) {
    if (!window.electron?.git) return;
    try {
      await window.electron.git.stage(cwd, paths ? { files: paths } : { all: true });
      setFileDiffs({});       // clear cached diffs — staging changes them
      setExpandedFiles(new Set());
      await fetchStatus();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleUnstage(paths?: string[]) {
    if (!window.electron?.git) return;
    try {
      await window.electron.git.unstage(cwd, paths ? { files: paths } : { all: true });
      setFileDiffs({});       // clear cached diffs — unstaging changes them
      setExpandedFiles(new Set());
      await fetchStatus();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleDiscard(paths: string[]) {
    if (!window.electron?.git) return;

    let confirmMessage = "";
    if (paths.length === 1) {
      const p = paths[0];
      const isStaged = status?.staged.some((f) => f.path === p);
      const isUnstaged = status?.unstaged.some((f) => f.path === p);
      const isUntracked = status?.untracked.some((f) => f.path === p);

      if (isUntracked) {
        confirmMessage = `Are you sure you want to delete the untracked file ${p}? This cannot be undone.`;
      } else if (isStaged && isUnstaged) {
        confirmMessage = `Are you sure you want to discard unstaged changes in ${p}? Staged changes will be preserved.`;
      } else if (isStaged) {
        confirmMessage = `Are you sure you want to discard staged changes in ${p}? This will revert the file to its HEAD state.`;
      } else {
        confirmMessage = `Are you sure you want to discard changes in ${p}? This cannot be undone.`;
      }
    } else {
      const containsUntracked = paths.some(p => status?.untracked.some(f => f.path === p));
      const containsStaged = paths.some(p => status?.staged.some(f => f.path === p));
      const containsUnstaged = paths.some(p => status?.unstaged.some(f => f.path === p));

      if (containsUntracked && !containsStaged && !containsUnstaged) {
        confirmMessage = `Are you sure you want to delete these ${paths.length} untracked files? This cannot be undone.`;
      } else if (containsStaged && containsUnstaged) {
        confirmMessage = `Are you sure you want to discard unstaged changes in these ${paths.length} files? Staged changes in partially staged files will be preserved.`;
      } else {
        confirmMessage = `Are you sure you want to discard changes in these ${paths.length} files? This cannot be undone.`;
      }
    }

    if (!window.confirm(confirmMessage)) return;

    setLoading(true);
    setError(null);
    try {
      for (const p of paths) {
        await window.electron.git.discard(cwd, p);
      }
      setFileDiffs({});
      setExpandedFiles(new Set());
      await fetchStatus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const filteredBranches = useMemo(() => {
    if (!branchSearch) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(branchSearch.toLowerCase()));
  }, [branches, branchSearch]);

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
      setFileDiffs({});
      setExpandedFiles(new Set());
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
      await fetchPrStatus();
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

  async function handleToggleFile(path: string, staged: boolean) {
    if (!window.electron?.git) return;
    const key = diffKey(path, staged);
    // If collapsing, just remove from expanded set
    if (expandedFiles.has(key)) {
      setExpandedFiles((prev) => { const n = new Set(prev); n.delete(key); return n; });
      return;
    }
    // Expanding — add to expanded + fetch diff
    setExpandedFiles((prev) => { const n = new Set(prev); n.add(key); return n; });
    setLoadingFile(key);
    try {
      const result = await window.electron.git.diffFile(cwd, path, staged);
      setFileDiffs((prev) => ({ ...prev, [key]: { ...result.stat, diff: result.diff } }));
    } catch {
      setFileDiffs((prev) => ({ ...prev, [key]: { added: 0, deleted: 0, diff: "" } }));
    }
    setLoadingFile(null);
  }

  async function handleGeneratePrDesc() {
    if (!window.electron?.git || !window.electron?.ai || !status) return;
    setGeneratingPrDesc(true);
    setError(null);
    try {
      const baseBranch = status.defaultBranch || "main";
      const diff = await window.electron.git.diffBranch(cwd, baseBranch);
      if (!diff) {
        setError(`No committed changes on this branch relative to ${baseBranch} to generate description from.`);
        return;
      }
      const config = {
        baseUrl: agentConfig.baseUrl,
        model: agentConfig.model,
        apiKey: agentConfig.apiKey,
      };

      const project = projects.find((p) => p.id === activeProjectId) ?? null;
      const projectSettings = project?.projectSettings as ProjectSettings | undefined;
      let template = "";

      if (projectSettings?.useRepoPrTemplate) {
        // Explicitly prefer repository template
        if (window.electron?.agent) {
          try {
            const pathSeparator = window.electron.platform === "win32" ? "\\" : "/";
            const templatePath = `${cwd}${pathSeparator}.github${pathSeparator}PULL_REQUEST_TEMPLATE.md`;
            template = await window.electron.agent.readFile(templatePath);
          } catch {
            // Fallback to empty if not found
          }
        }
      } else {
        // Use custom settings template (if set), otherwise fall back to repository template
        template = projectSettings?.prTemplate || "";
        if (!template && window.electron?.agent) {
          try {
            const pathSeparator = window.electron.platform === "win32" ? "\\" : "/";
            const templatePath = `${cwd}${pathSeparator}.github${pathSeparator}PULL_REQUEST_TEMPLATE.md`;
            template = await window.electron.agent.readFile(templatePath);
          } catch {
            // Ignore
          }
        }
      }

      const result = await window.electron.ai.generatePrDescription({ 
        diff, 
        config, 
        template: template || undefined 
      });
      setPrTitle(result.title);
      setPrBody(result.description);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGeneratingPrDesc(false);
    }
  }

  async function handleCreatePr() {
    if (!window.electron?.git) return;
    if (!prTitle.trim()) return;
    setCreatingPr(true);
    setError(null);
    try {
      // Push any pending commits first so the PR includes everything
      try {
        await window.electron.git.push(cwd, false);
      } catch { /* may already be up to date */ }
      const result = await window.electron.git.createPr(cwd, {
        title: prTitle.trim(),
        body: prBody.trim() || undefined,
      });
      setPrUrl(result.url);
      setShowPrForm(false);
      setPrTitle("");
      setPrBody("");
      fetchPrStatus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreatingPr(false);
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors border border-[var(--border)] bg-[var(--surface-2)] shadow-sm cursor-pointer">
                <GitBranch size={12} className="text-[var(--accent)]" />
                <span className="font-mono truncate max-w-[120px]">{status.branch}</span>
                <ChevronDown size={10} className="text-[var(--text-tertiary)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56 max-h-[300px] overflow-y-auto flex flex-col">
              <DropdownMenuLabel className="flex items-center justify-between pb-1">
                <span>Branches</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setNewBranchOpen(true);
                  }}
                  className="text-[0.65rem] text-[var(--accent)] hover:underline normal-case font-normal cursor-pointer"
                >
                  New Branch
                </button>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5">
                <input
                  type="text"
                  placeholder="Filter branches..."
                  value={branchSearch}
                  onChange={(e) => setBranchSearch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full text-xs px-2 py-1 border border-[var(--border)] rounded bg-[var(--surface)] text-[var(--text-primary)] focus:outline-none"
                />
              </div>
              <DropdownMenuSeparator />
              <div className="overflow-y-auto max-h-[180px] flex-1">
                {filteredBranches.map((b) => (
                  <DropdownMenuItem
                    key={b.name}
                    onClick={() => handleCheckout(b.name)}
                    className="flex items-center justify-between font-mono text-xs"
                  >
                    <span className={cn("truncate flex-1", b.current && "font-bold text-[var(--accent)]")}>
                      {b.name}
                    </span>
                    {b.current && <Check size={12} className="text-[var(--accent)] flex-shrink-0" />}
                  </DropdownMenuItem>
                ))}
                {filteredBranches.length === 0 && (
                  <div className="px-2.5 py-1.5 text-xs text-[var(--text-tertiary)] italic">
                    No branches found
                  </div>
                )}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

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
          <Tooltip content="Push committed changes to remote repository">
            <button
              onClick={handlePush}
              disabled={pushing || !status || (status.hasUpstream && Number(status.ahead) === 0)}
              className="px-2 py-0.5 rounded text-[0.65rem] font-semibold text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--on-accent)] border border-[var(--accent)] transition-colors disabled:opacity-50 cursor-pointer"
            >
              <ArrowUp size={10} className="inline mr-0.5" />
              {pushing ? "Pushing..." : "Push"}
            </button>
          </Tooltip>
          {prStatus && (
            <Tooltip content={prStatus.title || "Open pull request in browser"}>
              <button
                onClick={() => { if (prStatus.url) window.electron?.openExternal(prStatus.url); }}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[0.65rem] font-semibold text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--on-accent)] border border-[var(--accent)] transition-colors cursor-pointer"
              >
                <GitPullRequest size={10} />
                <span>
                  {prStatus.url?.match(/pull\/(\d+)/)?.[1]
                    ? `#${prStatus.url.match(/pull\/(\d+)/)?.[1]}`
                    : "PR"}
                  {prStatus.state ? ` (${prStatus.state.toLowerCase()})` : ""}
                </span>
              </button>
            </Tooltip>
          )}
          {!prStatus && status.hasUpstream && Number(status.ahead) === 0 && !hasChanges && status.branch !== status.defaultBranch && (
            <Tooltip content={showPrForm ? "Close pull request creation form" : "Create pull request on GitHub"}>
              <button
                onClick={() => { setShowPrForm((v) => !v); setPrUrl(null); }}
                className="px-2 py-0.5 rounded text-[0.65rem] font-semibold text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--on-accent)] border border-[var(--accent)] transition-colors cursor-pointer"
              >
                {showPrForm ? "Cancel" : "Create PR"}
              </button>
            </Tooltip>
          )}
          <Tooltip content="Refresh git status and recent commits">
            <button
              onClick={refresh}
              className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors cursor-pointer"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            </button>
          </Tooltip>
        </div>
      )}

      {/* ── PR form ──────────────────────────────────────────────────────── */}
      {showPrForm && (
        <div className="border-b border-[var(--border)] px-4 py-3 space-y-2 bg-[var(--surface-2)] flex-shrink-0">
          <input
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            placeholder="PR title"
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 font-mono focus:outline-none"
          />
          <textarea
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            placeholder="PR description (optional)"
            rows={4}
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 font-mono focus:outline-none resize-y"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleGeneratePrDesc}
              disabled={generatingPrDesc || !status}
            >
              <Sparkles size={11} className={cn(generatingPrDesc && "animate-pulse")} />
              {generatingPrDesc ? "Generating..." : "Generate Description"}
            </Button>
            <div className="flex-1" />
            <Button size="sm" onClick={handleCreatePr} disabled={!prTitle.trim() || creatingPr}>
              {creatingPr ? "Creating..." : "Create PR"}
            </Button>
          </div>
        </div>
      )}

      {/* ── PR success ────────────────────────────────────────────────────── */}
      {prUrl && (
        <div className="flex items-center gap-2 px-4 py-2 bg-[color-mix(in_srgb,var(--success)_8%,transparent)] border-b border-[var(--border)] flex-shrink-0">
          <Check size={11} className="text-[var(--success)] flex-shrink-0" />
          <span className="text-[0.714rem] text-[var(--text-primary)] flex-1 truncate">
            PR created: {prUrl}
          </span>
          <button
            onClick={() => { window.electron?.openExternal(prUrl); }}
            className="text-[0.65rem] text-[var(--accent)] hover:underline flex-shrink-0 hover:scale-102"
          >
            Open
          </button>
          <button onClick={() => setPrUrl(null)} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
            <X size={11} />
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
                expanded={expandedSections.staged}
                onToggle={() => toggleSection("staged")}
                action={
                  <Tooltip content="Unstage all currently staged changes">
                    <button
                      onClick={() => handleUnstage()}
                      className="text-[0.65rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-2 py-0.5 rounded hover:bg-[var(--surface-3)] transition-colors cursor-pointer"
                    >
                      Unstage all
                    </button>
                  </Tooltip>
                }
              >
                {status.staged.map((file) => {
                  const key = diffKey(file.path, true);
                  return (
                    <FileRow
                      key={file.path}
                      path={file.path}
                      status={file.status}
                      onAction={() => handleUnstage([file.path])}
                      onDiscard={() => handleDiscard([file.path])}
                      actionLabel="-"
                      actionColor="var(--danger)"
                      stat={fileDiffs[key]}
                      rawDiff={fileDiffs[key]?.diff ?? ""}
                      expanded={expandedFiles.has(key)}
                      loading={loadingFile === key}
                      onToggle={() => handleToggleFile(file.path, true)}
                    />
                  );
                })}
              </FileSection>
            )}

            {/* Unstaged */}
            {status && status.unstaged.length > 0 && (
              <FileSection
                label="Modified"
                count={status.unstaged.length}
                expanded={expandedSections.unstaged}
                onToggle={() => toggleSection("unstaged")}
                action={
                  <div className="flex items-center gap-1.5">
                    <Tooltip content="Discard all unstaged changes in modified files">
                      <button
                        onClick={() => handleDiscard(status.unstaged.map((f) => f.path))}
                        className="text-[0.65rem] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-2 py-0.5 rounded transition-colors cursor-pointer"
                      >
                        Discard all
                      </button>
                    </Tooltip>
                    <Tooltip content="Stage all modified files">
                      <button
                        onClick={() => handleStage(status.unstaged.map((f) => f.path))}
                        className="text-[0.65rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-2 py-0.5 rounded hover:bg-[var(--surface-3)] transition-colors cursor-pointer"
                      >
                        Stage all
                      </button>
                    </Tooltip>
                  </div>
                }
              >
                {status.unstaged.map((file) => {
                  const key = diffKey(file.path, false);
                  return (
                    <FileRow
                      key={file.path}
                      path={file.path}
                      status={file.status}
                      onAction={() => handleStage([file.path])}
                      onDiscard={() => handleDiscard([file.path])}
                      actionLabel="+"
                      actionColor="var(--success)"
                      stat={fileDiffs[key]}
                      rawDiff={fileDiffs[key]?.diff ?? ""}
                      expanded={expandedFiles.has(key)}
                      loading={loadingFile === key}
                      onToggle={() => handleToggleFile(file.path, false)}
                    />
                  );
                })}
              </FileSection>
            )}

            {/* Untracked */}
            {status && status.untracked.length > 0 && (
              <FileSection
                label="Untracked"
                count={status.untracked.length}
                expanded={expandedSections.untracked}
                onToggle={() => toggleSection("untracked")}
                action={
                  <div className="flex items-center gap-1.5">
                    <Tooltip content="Permanently delete all untracked files">
                      <button
                        onClick={() => handleDiscard(status.untracked.map((f) => f.path))}
                        className="text-[0.65rem] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-2 py-0.5 rounded transition-colors cursor-pointer"
                      >
                        Clean all
                      </button>
                    </Tooltip>
                    <Tooltip content="Stage all untracked files">
                      <button
                        onClick={() => handleStage(status.untracked.map((f) => f.path))}
                        className="text-[0.65rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-2 py-0.5 rounded hover:bg-[var(--surface-3)] transition-colors cursor-pointer"
                      >
                        Stage all
                      </button>
                    </Tooltip>
                  </div>
                }
              >
                {status.untracked.map((file) => {
                  const key = diffKey(file.path, false);
                  return (
                    <FileRow
                      key={file.path}
                      path={file.path}
                      status={file.status}
                      onAction={() => handleStage([file.path])}
                      onDiscard={() => handleDiscard([file.path])}
                      actionLabel="+"
                      actionColor="var(--success)"
                      stat={fileDiffs[key]}
                      rawDiff={fileDiffs[key]?.diff ?? ""}
                      expanded={expandedFiles.has(key)}
                      loading={loadingFile === key}
                      onToggle={() => handleToggleFile(file.path, false)}
                    />
                  );
                })}
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
              <Tooltip content="Generate AI commit message based on staged changes">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleGenerate}
                  disabled={generating || stagedCount === 0}
                  className="cursor-pointer"
                >
                  <Sparkles size={11} className={cn(generating && "animate-pulse")} />
                  {generating ? "Generating..." : "Generate"}
                </Button>
              </Tooltip>
              <div className="flex-1" />
              <Tooltip content="Commit staged changes to local repository branch">
                <Button
                  size="sm"
                  onClick={handleCommit}
                  disabled={!commitSubject.trim() || committing}
                  className="cursor-pointer"
                >
                  {committing ? "Committing..." : "Commit"}
                </Button>
              </Tooltip>
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

      {/* ── New Branch Dialog ──────────────────────────────────────────────── */}
      <Dialog open={newBranchOpen} onOpenChange={setNewBranchOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Create New Branch</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateBranch} className="p-4 space-y-4">
            <div className="space-y-2">
              <label htmlFor="branch-name" className="text-xs text-[var(--text-secondary)]">Branch Name</label>
              <input
                id="branch-name"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                placeholder="e.g. feature/my-new-feature"
                className="w-full rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)] text-sm px-3 py-1.5 font-mono focus:outline-none"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setNewBranchOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!newBranchName.trim()}>
                Create & Checkout
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

