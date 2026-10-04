"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CairnEvents } from "@/lib/events";
import {
  type GitStatusData,
  type GitLogData,
  areGitStatusesEqual,
  areBranchesEqual,
  areLogEntriesEqual,
  arePrStatusesEqual,
} from "./git-helpers";

export interface GitPrStatus { url: string | null; state: string | null; title: string | null }

const STATUS_POLL_MS = 10_000;

/**
 * Repository state for the Git panel: status (polled every 10s), recent log,
 * branches and the current branch's PR. Each fetch keeps the previous object
 * when nothing changed, so polling doesn't re-render the panel.
 */
export function useGitStatus(cwd: string) {
  const [status, setStatus] = useState<GitStatusData | null>(null);
  const [log, setLog] = useState<GitLogData>([]);
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean }>>([]);
  const [prStatus, setPrStatus] = useState<GitPrStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Signature of the working-tree file set (paths across all sections). When
  // it changes between polls, the FileTree is told to refresh so externally
  // added/removed files appear without a manual refresh.
  const prevFileSigRef = useRef<string | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!window.electron?.git) return;
    try {
      const s = await window.electron.git.status(cwd);
      setStatus((prev) => (areGitStatusesEqual(prev, s) ? prev : s));
      setError((prev) => (prev !== null ? null : prev));
      // Only a change to the file SET (added/removed/renamed) alters the
      // directory listing; staged ↔ unstaged moves don't.
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
      setLoading((prev) => (prev ? false : prev));
    }
  }, [cwd]);

  const fetchBranches = useCallback(async () => {
    if (!window.electron?.git) return;
    try {
      const res = await window.electron.git.branches(cwd);
      setBranches((prev) => (areBranchesEqual(prev, res.branches) ? prev : res.branches));
    } catch { /* best-effort */ }
  }, [cwd]);

  const fetchLog = useCallback(async () => {
    if (!window.electron?.git) return;
    try {
      const entries = await window.electron.git.log(cwd, 15);
      setLog((prev) => (areLogEntriesEqual(prev, entries) ? prev : entries));
    } catch { /* log fetch is best-effort */ }
  }, [cwd]);

  const fetchPrStatus = useCallback(async () => {
    if (!window.electron?.git) return;
    try {
      const next = await window.electron.git.prStatus(cwd);
      setPrStatus((prev) => (arePrStatusesEqual(prev, next) ? prev : next));
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
    const poll = setInterval(fetchStatus, STATUS_POLL_MS);
    return () => clearInterval(poll);
  }, [refresh, fetchStatus]);

  return {
    status, log, branches, prStatus, loading, setLoading, error, setError,
    fetchStatus, fetchLog, fetchPrStatus, fetchBranches, refresh,
  };
}
