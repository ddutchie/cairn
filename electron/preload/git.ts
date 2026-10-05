/** Git operations (Agent Git tab). */

import { invokeContract } from "./ipc";
import type { GitPathSelection, GitStashAction } from "../../shared/types/git";

export const gitApi = {
  // ── Git operations (Agent Git tab) ────────────
  git: {
    status:   (cwd: string) => invokeContract("git:status", { cwd }),
    branches: (cwd: string) => invokeContract("git:branches", { cwd }),
    checkout: (cwd: string, branch: string, create?: boolean) => invokeContract("git:checkout", { cwd, branch, create }),
    stage:    (cwd: string, opts?: GitPathSelection) => invokeContract("git:stage", { cwd, ...opts }),
    unstage:  (cwd: string, opts?: GitPathSelection) => invokeContract("git:unstage", { cwd, ...opts }),
    commit:   (cwd: string, message: string, body?: string, autoStage?: boolean) => invokeContract("git:commit", { cwd, message, body, autoStage }),
    push:     (cwd: string, setUpstream?: boolean) => invokeContract("git:push", { cwd, setUpstream }),
    log:      (cwd: string, count?: number) => invokeContract("git:log", { cwd, count }),
    diff:     (cwd: string, staged?: boolean) => invokeContract("git:diff", { cwd, staged }),
    diffBranch: (cwd: string, baseBranch: string) => invokeContract("git:diffBranch", { cwd, baseBranch }),
    diffFile: (cwd: string, filePath: string, staged?: boolean) => invokeContract("git:diffFile", { cwd, filePath, staged }),
    stash:    (cwd: string, action: GitStashAction) => invokeContract("git:stash", { cwd, action }),
    createPr: (cwd: string, opts: { title: string; body?: string; base?: string }) => invokeContract("git:createPr", { cwd, ...opts }),
    prStatus: (cwd: string) => invokeContract("git:prStatus", { cwd }),
    discard:  (cwd: string, filePath: string) => invokeContract("git:discard", { cwd, filePath }),
  },
} as const;
