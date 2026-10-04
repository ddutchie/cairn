/**
 * Typed client for the `git:*` IPC channels. Every call needs a `cwd` inside
 * one of the workspace's project code directories (checked in main).
 */

import type {
  GitBranchList, GitFileDiff, GitLogEntry, GitPrStatus, GitStashAction, GitStatus,
} from "../../../shared/types/git";
import { domainCall, type ElectronApi } from "./client";

const git = <T>(fn: (api: ElectronApi["git"]) => Promise<T>) => domainCall("git", fn);

export const gitClient = {
  status: (cwd: string): Promise<GitStatus> => git((g) => g.status(cwd)),
  branches: (cwd: string): Promise<GitBranchList> => git((g) => g.branches(cwd)),
  /** Switch to `branch`, or create it from HEAD when `create` is set. */
  checkout: (cwd: string, branch: string, create = false) => git((g) => g.checkout(cwd, branch, create)),
  /** Stage the given paths, or everything when `paths` is omitted. */
  stage: (cwd: string, paths?: string[]) => git((g) => g.stage(cwd, paths ? { files: paths } : { all: true })),
  /** Unstage the given paths, or everything when `paths` is omitted. */
  unstage: (cwd: string, paths?: string[]) => git((g) => g.unstage(cwd, paths ? { files: paths } : { all: true })),
  /** Commit with `git add .` first when `autoStage` is set. */
  commit: (cwd: string, opts: { subject: string; body?: string; autoStage?: boolean }) =>
    git((g) => g.commit(cwd, opts.subject, opts.body, opts.autoStage)),
  push: (cwd: string, opts: { setUpstream?: boolean } = {}) => git((g) => g.push(cwd, opts.setUpstream)),
  log: (cwd: string, count?: number): Promise<GitLogEntry[]> => git((g) => g.log(cwd, count)),
  /** Unified diff of the index (`staged`) or of the working tree against HEAD. */
  diff: (cwd: string, opts: { staged?: boolean } = {}): Promise<string> => git((g) => g.diff(cwd, opts.staged)),
  diffBranch: (cwd: string, baseBranch: string): Promise<string> => git((g) => g.diffBranch(cwd, baseBranch)),
  diffFile: (cwd: string, filePath: string, staged = false): Promise<GitFileDiff> => git((g) => g.diffFile(cwd, filePath, staged)),
  stash: (cwd: string, action: GitStashAction) => git((g) => g.stash(cwd, action)),
  createPr: (cwd: string, opts: { title: string; body?: string; base?: string }) => git((g) => g.createPr(cwd, opts)),
  /** null when `gh` is unavailable or the branch has no PR. */
  prStatus: (cwd: string): Promise<GitPrStatus | null> => git((g) => g.prStatus(cwd)),
  /** Discard each path in turn; stops at the first failure. */
  async discard(cwd: string, paths: string[]): Promise<void> {
    for (const p of paths) await git((g) => g.discard(cwd, p));
  },
};
