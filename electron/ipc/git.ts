/**
 * Cairn — Git IPC handlers for the Agent Git tab.
 *
 * All operations are scoped to a `cwd` (project code directory) and run
 * `git` subprocesses via `child_process.spawnSync`.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { registerIpcHandle } from "./registry";
import { handle } from "./result-helpers";
import type { Database } from "better-sqlite3";

function assertWithinCodeDirectory(db: Database, cwd: string): void {
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Not a valid directory: ${cwd}`);
  }
  const normalised = path.resolve(cwd);
  const codeDirs = db
    .prepare("SELECT code_directory FROM projects WHERE code_directory IS NOT NULL")
    .all() as { code_directory: string }[];
  const allowed = codeDirs.some(({ code_directory }) => {
    const dir = path.resolve(code_directory);
    return normalised === dir || normalised.startsWith(dir + path.sep);
  });
  if (!allowed) {
    throw new Error(`Directory is outside any registered code directory: ${cwd}`);
  }
}

function git(args: string[], cwd: string, timeout = 15_000): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(stderr || stdout || `git ${args[0]} failed (exit ${result.status})`);
  }
  return (result.stdout ?? "").trim();
}

function gitSafe(args: string[], cwd: string, timeout = 15_000): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status,
  };
}

export function registerGitHandlers(db: Database): void {
  // ── git status ──────────────────────────────────────────────────────────
  registerIpcHandle("git:status", (_e, { cwd }: { cwd: string }) =>
    handle(() => {
      assertWithinCodeDirectory(db, cwd);
      const branch = gitSafe(["rev-parse", "--abbrev-ref", "HEAD"], cwd).stdout || "HEAD";
      const porcelain = git(["status", "--porcelain"], cwd);
      const lines = porcelain ? porcelain.split("\n").filter(Boolean) : [];
      const staged: Array<{ path: string; status: string }> = [];
      const unstaged: Array<{ path: string; status: string }> = [];
      const untracked: Array<{ path: string; status: string }> = [];
      for (const line of lines) {
        const x = line[0];
        const y = line[1];
        const filePath = line.slice(2).trim();
        if (x === "?" && y === "?") {
          untracked.push({ path: filePath, status: "??" });
        } else if (x !== " ") {
          staged.push({ path: filePath, status: x + y });
        }
        if (y !== " ") {
          unstaged.push({ path: filePath, status: x + y });
        }
      }
      const aheadBehind = gitSafe(["rev-list", "--count", "--left-right", `${branch}@{upstream}...HEAD`], cwd);
      const hasUpstream = aheadBehind.status === 0 && aheadBehind.stdout !== "";
      const [ahead = "0", behind = "0"] = aheadBehind.stdout ? aheadBehind.stdout.split("\t") : ["0", "0"];
      const defaultBranch = gitSafe(["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd).stdout.replace("origin/", "").trim() || "main";
      return { branch, ahead, behind, hasUpstream, defaultBranch, staged, unstaged, untracked };
    })
  );

  // ── git branches ─────────────────────────────────────────────────────────
  registerIpcHandle("git:branches", (_e, { cwd }: { cwd: string }) =>
    handle(() => {
      assertWithinCodeDirectory(db, cwd);
      const current = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      const output = git(["branch", "-a"], cwd);
      const branches = output.split("\n").filter(Boolean).map((line) => ({
        name: line.replace(/^\*?\s*/, "").trim(),
        current: line.startsWith("*"),
      }));
      return { current, branches };
    })
  );

  // ── git checkout / create branch ─────────────────────────────────────────
  registerIpcHandle("git:checkout", (_e, { cwd, branch, create }: { cwd: string; branch: string; create?: boolean }) =>
    handle(() => {
      assertWithinCodeDirectory(db, cwd);
      const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
      git(args, cwd);
      return { branch };
    })
  );

  // ── git stage ────────────────────────────────────────────────────────────
  registerIpcHandle("git:stage", (_e, { cwd, files, all }: { cwd: string; files?: string[]; all?: boolean }) =>
    handle(() => {
      assertWithinCodeDirectory(db, cwd);
      if (all) {
        git(["add", "-A"], cwd);
      } else if (files && files.length > 0) {
        git(["add", "--", ...files], cwd);
      }
      return { ok: true };
    })
  );

  // ── git unstage ──────────────────────────────────────────────────────────
  registerIpcHandle("git:unstage", (_e, { cwd, files, all }: { cwd: string; files?: string[]; all?: boolean }) =>
    handle(() => {
      assertWithinCodeDirectory(db, cwd);
      if (all) {
        git(["reset", "HEAD"], cwd);
      } else if (files && files.length > 0) {
        git(["reset", "HEAD", "--", ...files], cwd);
      }
      return { ok: true };
    })
  );

  // ── git commit ───────────────────────────────────────────────────────────
  registerIpcHandle("git:commit", (_e, { cwd, message, body, autoStage }: { cwd: string; message: string; body?: string; autoStage?: boolean }) =>
    handle(() => {
      assertWithinCodeDirectory(db, cwd);
      if (autoStage) {
        git(["add", "-A"], cwd);
      }
      const fullMessage = body ? `${message}\n\n${body}` : message;
      git(["commit", "-m", fullMessage], cwd, 30_000);
      const hash = git(["rev-parse", "HEAD"], cwd).slice(0, 12);
      return { hash, message };
    })
  );

  // ── git push ─────────────────────────────────────────────────────────────
  registerIpcHandle("git:push", (_e, { cwd, setUpstream }: { cwd: string; setUpstream?: boolean }) =>
    handle(() => {
      assertWithinCodeDirectory(db, cwd);
      const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      const args = ["push"];
      if (setUpstream) args.push("-u", "origin", branch);
      else args.push("origin", branch);
      git(args, cwd, 60_000);
      return { branch };
    })
  );

  // ── git log ──────────────────────────────────────────────────────────────
  registerIpcHandle("git:log", (_e, { cwd, count = 20 }: { cwd: string; count?: number }) =>
    handle(() => {
      assertWithinCodeDirectory(db, cwd);
      const output = git(["log", `--max-count=${count}`, "--format=%H|%an|%ai|%s"], cwd);
      if (!output) return [];
      return output.split("\n").filter(Boolean).map((line) => {
        const [hash, author, date, ...rest] = line.split("|");
        return { hash: hash?.slice(0, 12) ?? "", author: author ?? "", date: date ?? "", subject: rest.join("|") ?? "" };
      });
    })
  );

  // ── git diff (for commit message generation) ───────────────────────────
  registerIpcHandle("git:diff", (_e, { cwd, staged }: { cwd: string; staged?: boolean }) =>
    handle(() => {
      assertWithinCodeDirectory(db, cwd);
      const args = staged ? ["diff", "--cached", "--unified=3"] : ["diff", "HEAD", "--unified=3"];
      const result = gitSafe(args, cwd);
      if (result.status !== 0) {
        const fallback = gitSafe(["diff", "--cached", "--unified=3"], cwd);
        return fallback.stdout || "";
      }
      return result.stdout || "";
    })
  );

  // ── git diffFile (stat + full diff for one file) ───────────────────────
  registerIpcHandle("git:diffFile", (_e, { cwd, filePath, staged }: { cwd: string; filePath: string; staged?: boolean }) =>
    handle(() => {
      assertWithinCodeDirectory(db, cwd);
      // For untracked files (staged=false), git diff HEAD returns empty because
      // the file isn't in HEAD. Use --no-index to diff against /dev/null.
      const statSafe = gitSafe(
        staged
          ? ["diff", "--cached", "--numstat", "--", filePath]
          : ["diff", "HEAD", "--numstat", "--", filePath],
        cwd,
      );
      const match = statSafe.stdout.match(/^(\d+)\s+(\d+)/);
      const added = match ? Number(match[1]) : 0;
      const deleted = match ? Number(match[2]) : 0;

      let diff: string;
      if (staged) {
        diff = gitSafe(["diff", "--cached", "--unified=10", "--", filePath], cwd).stdout;
      } else {
        const r = gitSafe(["diff", "HEAD", "--unified=10", "--", filePath], cwd);
        diff = r.stdout || "";
        // If empty, file might be untracked — diff against /dev/null
        if (!diff) {
          const untracked = gitSafe(["diff", "--no-index", "--unified=10", "/dev/null", filePath], cwd);
          diff = untracked.stdout || "";
        }
      }
      return { stat: { added, deleted }, diff: diff || "" };
    })
  );

  // ── git createPr ─────────────────────────────────────────────────────────
  registerIpcHandle("git:createPr", (_e, { cwd, title, body, base }: { cwd: string; title: string; body?: string; base?: string }) =>
    handle(() => {
      assertWithinCodeDirectory(db, cwd);
      const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      const check = spawnSync("gh", ["--version"], { encoding: "utf-8", timeout: 5_000 });
      if (check.error || check.status !== 0) {
        throw new Error("GitHub CLI (`gh`) is not installed or not in PATH. Install it from https://cli.github.com/ to create PRs.");
      }
      const ghArgs = ["pr", "create", "--title", title, "--head", branch];
      if (body) ghArgs.push("--body", body);
      if (base) ghArgs.push("--base", base);
      const result = spawnSync("gh", ghArgs, { cwd, encoding: "utf-8", timeout: 30_000 });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error((result.stderr ?? "").trim() || (result.stdout ?? "").trim() || "gh pr create failed");
      }
      const url = (result.stdout ?? "").trim();
      return { url, branch };
    })
  );

  // ── git stash / stash pop ───────────────────────────────────────────────
  registerIpcHandle("git:stash", (_e, { cwd, action }: { cwd: string; action: "push" | "pop" | "list" }) =>
    handle(() => {
      assertWithinCodeDirectory(db, cwd);
      if (action === "list") {
        const output = git(["stash", "list"], cwd);
        return output ? output.split("\n").filter(Boolean) : [];
      }
      git(["stash", action], cwd);
      return { ok: true };
    })
  );
}
