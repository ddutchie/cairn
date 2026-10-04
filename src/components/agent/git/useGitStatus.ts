"use client";

import { useCallback, useEffect, useRef } from "react";
import { CairnEvents } from "@/lib/events";
import { gitClient } from "@/lib/ipc/git";
import { useIpcQuery } from "@/hooks/useIpcQuery";
import type { GitPrStatus } from "../../../../shared/types/git";
import {
  type GitLogData,
  areGitStatusesEqual,
  areBranchesEqual,
  areLogEntriesEqual,
  arePrStatusesEqual,
} from "./git-helpers";

const STATUS_POLL_MS = 10_000;
const LOG_COUNT = 15;
const NO_LOG: GitLogData = [];
const NO_BRANCHES: Array<{ name: string; current: boolean }> = [];

/**
 * Repository state for the Git panel: status (polled every 10s), recent log,
 * branches and the current branch's PR. Each fetch keeps the previous object
 * when nothing changed, so polling doesn't re-render the panel. Only a status
 * failure is reported (`error`); log, branches and PR status are best-effort.
 */
export function useGitStatus(cwd: string) {
  const statusQ = useIpcQuery(() => gitClient.status(cwd), [cwd], {
    pollMs: STATUS_POLL_MS,
    isEqual: areGitStatusesEqual,
  });
  const logQ = useIpcQuery(() => gitClient.log(cwd, LOG_COUNT), [cwd], {
    initialData: NO_LOG,
    isEqual: areLogEntriesEqual,
  });
  const branchesQ = useIpcQuery(async () => (await gitClient.branches(cwd)).branches, [cwd], {
    initialData: NO_BRANCHES,
    isEqual: areBranchesEqual,
  });
  const prQ = useIpcQuery<GitPrStatus | null>(() => gitClient.prStatus(cwd), [cwd], {
    initialData: null,
    isEqual: arePrStatusesEqual,
  });

  const status = statusQ.data ?? null;

  // Signature of the working-tree file set (paths across all sections). When
  // it changes between polls, the FileTree is told to refresh so externally
  // added/removed files appear without a manual refresh. Staged ↔ unstaged
  // moves don't change the directory listing, so they don't count.
  const prevFileSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (!status) return;
    const sig = [...status.staged, ...status.unstaged, ...status.untracked]
      .map((f) => f.path)
      .sort()
      .join("|");
    if (prevFileSigRef.current !== null && prevFileSigRef.current !== sig) {
      window.dispatchEvent(CairnEvents.agentFilesChanged());
    }
    prevFileSigRef.current = sig;
  }, [status]);

  const { reload: reloadStatus } = statusQ;
  const { reload: reloadLog } = logQ;
  const { reload: reloadBranches } = branchesQ;
  const { reload: reloadPr } = prQ;
  const fetchStatus = useCallback(() => reloadStatus({ silent: true }), [reloadStatus]);
  const fetchLog = useCallback(() => reloadLog({ silent: true }), [reloadLog]);
  const fetchPrStatus = useCallback(() => reloadPr({ silent: true }), [reloadPr]);
  const refresh = useCallback(
    () => Promise.all([reloadStatus(), reloadLog(), reloadPr(), reloadBranches()]).then(() => undefined),
    [reloadStatus, reloadLog, reloadPr, reloadBranches],
  );

  return {
    status,
    log: logQ.data,
    branches: branchesQ.data,
    // A failed lookup means "no PR we can show", not a stale one.
    prStatus: prQ.error ? null : prQ.data,
    // Status drives the panel; the gh-backed PR lookup can lag well behind it.
    loading: statusQ.loading,
    error: statusQ.error,
    clearError: statusQ.clearError,
    fetchStatus, fetchLog, fetchPrStatus, refresh,
  };
}
