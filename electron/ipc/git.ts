import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { registerIpcHandle } from "./registry";
import { handle } from "./result-helpers";
import type { Database } from "better-sqlite3";

function assertWithinCodeDirectory(db: Database, cwd: string): void {
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Not a valid directory: ${cwd}`);
  }
  const normalised = fs.realpathSync(cwd);
  const codeDirs = db
    .prepare("SELECT code_directory FROM projects WHERE code_directory IS NOT NULL")
    .all() as { code_directory: string }[];
  const allowed = codeDirs.some(({ code_directory }) => {
    try {
      if (!fs.existsSync(code_directory)) return false;
      const dir = fs.realpathSync(code_directory);
      return normalised === dir || normalised.startsWith(dir + path.sep);
    } catch {
      return false;
    }
  });
  if (!allowed) {
    throw new Error(`Directory is outside any registered code directory: ${cwd}`);
  }
}

function isPathWithinCwd(cwd: string, filePath: string): boolean {
  try {
    const canonicalCwd = fs.realpathSync(cwd);
    const absolutePath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(cwd, filePath);

    let existingPath = absolutePath;
    while (existingPath && !fs.existsSync(existingPath)) {
      const parent = path.dirname(existingPath);
      if (parent === existingPath) break;
      existingPath = parent;
    }

    const canonicalPath = fs.realpathSync(existingPath);
    const relative = path.relative(canonicalCwd, canonicalPath);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function isSafePathspec(file: string): boolean {
  if (file.startsWith(":")) return false;
  if (path.isAbsolute(file)) return false;
  const normalized = path.normalize(file);
  if (normalized.startsWith("..") || normalized.includes("..")) return false;
  return true;
}

function git(args: string[], cwd: string, timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const maxBuffer = 20 * 1024 * 1024; // 20MB
    execFile("git", args, { cwd, encoding: "utf-8", timeout, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        if (
          error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
          (error as { code?: number | string }).code === "ENOBUFS" ||
          error.message?.includes("maxBuffer exceeded")
        ) {
          reject(new Error("Git command output exceeded maximum buffer size limit (diff too large)"));
          return;
        }
        const errStatus = (error as { code?: number | string }).code;
        const stderrTrimmed = (stderr ?? "").trim();
        const stdoutTrimmed = (stdout ?? "").trim();
        reject(new Error(stderrTrimmed || stdoutTrimmed || error.message || `git ${args[0]} failed (exit ${errStatus})`));
      } else {
        resolve((stdout ?? "").trimEnd());
      }
    });
  });
}

function gitSafe(args: string[], cwd: string, timeout = 15_000): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    const maxBuffer = 20 * 1024 * 1024; // 20MB
    execFile("git", args, { cwd, encoding: "utf-8", timeout, maxBuffer }, (error, stdout, stderr) => {
      const code = error ? (error as { code?: number | string }).code : 0;
      const status = typeof code === "number" ? code : (error ? 1 : 0);
      resolve({
        stdout: (stdout ?? "").trimEnd(),
        stderr: (stderr ?? "").trim(),
        status,
      });
    });
  });
}

export function registerGitHandlers(db: Database): void {
  // ── git status ──────────────────────────────────────────────────────────
  registerIpcHandle("git:status", (_e, { cwd }: { cwd: string }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      const branch = (await gitSafe(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).stdout || "HEAD";
      const porcelain = await git(["status", "--porcelain=v1", "-z"], cwd);
      const parts = porcelain ? porcelain.split("\0") : [];
      const staged: Array<{ path: string; status: string }> = [];
      const unstaged: Array<{ path: string; status: string }> = [];
      const untracked: Array<{ path: string; status: string }> = [];
      let i = 0;
      while (i < parts.length) {
        const entry = parts[i];
        if (!entry) {
          i++;
          continue;
        }
        const x = entry[0];
        const y = entry[1];
        const filePath = entry.slice(3);

        // If it's a rename (R) or copy (C), consume the next NUL-separated part (the source path) without overriding filePath.
        if (x === "R" || x === "C") {
          i++;
        }

        if (x === "?" && y === "?") {
          untracked.push({ path: filePath, status: "??" });
        } else {
          if (x !== " ") {
            staged.push({ path: filePath, status: x + y });
          }
          if (y !== " ") {
            unstaged.push({ path: filePath, status: x + y });
          }
        }
        i++;
      }
      const aheadBehind = await gitSafe(["rev-list", "--count", "--left-right", `${branch}@{upstream}...HEAD`], cwd);
      const hasUpstream = aheadBehind.status === 0 && aheadBehind.stdout !== "";
      const [behind = "0", ahead = "0"] = aheadBehind.stdout ? aheadBehind.stdout.split("\t") : ["0", "0"];
      const defaultBranch = (await gitSafe(["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd)).stdout.replace("origin/", "").trim() || "main";
      return { branch, ahead, behind, hasUpstream, defaultBranch, staged, unstaged, untracked };
    })
  );

  // ── git branches ─────────────────────────────────────────────────────────
  registerIpcHandle("git:branches", (_e, { cwd }: { cwd: string }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      const output = await git(["branch", "-a"], cwd);
      const branches = output.split("\n").filter(Boolean).map((line) => ({
        name: line.replace(/^\*?\s*/, "").trim(),
        current: line.startsWith("*"),
      }));
      return { current, branches };
    })
  );

  // ── git checkout / create branch ─────────────────────────────────────────
  registerIpcHandle("git:checkout", (_e, { cwd, branch, create }: { cwd: string; branch: string; create?: boolean }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      if (branch.startsWith("-")) {
        throw new Error(`Invalid branch name: ${branch}`);
      }
      const checkBranch = await gitSafe(["check-ref-format", "--branch", branch], cwd);
      if (checkBranch.status !== 0) {
        throw new Error(`Invalid branch name: ${branch}`);
      }
      const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
      await git(args, cwd);
      return { branch };
    })
  );

  // ── git stage ────────────────────────────────────────────────────────────
  registerIpcHandle("git:stage", (_e, { cwd, files, all }: { cwd: string; files?: string[]; all?: boolean }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      if (all) {
        await git(["add", "--", "."], cwd);
      } else if (files && files.length > 0) {
        for (const file of files) {
          if (!isSafePathspec(file)) {
            throw new Error(`Access denied: invalid file pathspec: ${file}`);
          }
        }
        const literalFiles = files.map((file) => `:(literal)${file}`);
        await git(["add", "--", ...literalFiles], cwd);
      }
      return { ok: true };
    })
  );

  // ── git unstage ──────────────────────────────────────────────────────────
  registerIpcHandle("git:unstage", (_e, { cwd, files, all }: { cwd: string; files?: string[]; all?: boolean }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      if (all) {
        await git(["reset", "HEAD", "--", "."], cwd);
      } else if (files && files.length > 0) {
        for (const file of files) {
          if (!isSafePathspec(file)) {
            throw new Error(`Access denied: invalid file pathspec: ${file}`);
          }
        }
        const literalFiles = files.map((file) => `:(literal)${file}`);
        await git(["reset", "HEAD", "--", ...literalFiles], cwd);
      }
      return { ok: true };
    })
  );

  // ── git commit ───────────────────────────────────────────────────────────
  registerIpcHandle("git:commit", (_e, { cwd, message, body, autoStage }: { cwd: string; message: string; body?: string; autoStage?: boolean }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      if (autoStage) {
        await git(["add", "--", "."], cwd);
      }
      const fullMessage = body ? `${message}\n\n${body}` : message;
      await git(["commit", "-m", fullMessage], cwd, 30_000);
      const hash = (await git(["rev-parse", "HEAD"], cwd)).slice(0, 12);
      return { hash, message };
    })
  );

  // ── git push ─────────────────────────────────────────────────────────────
  registerIpcHandle("git:push", (_e, { cwd, setUpstream }: { cwd: string; setUpstream?: boolean }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      const args = ["push"];
      if (setUpstream) args.push("-u", "origin", branch);
      else args.push("origin", branch);
      await git(args, cwd, 60_000);
      return { branch };
    })
  );

  // ── git log ──────────────────────────────────────────────────────────────
  registerIpcHandle("git:log", (_e, { cwd, count = 20 }: { cwd: string; count?: number }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      let clampedCount = 20;
      if (typeof count === "number" && Number.isFinite(count)) {
        clampedCount = Math.max(1, Math.min(100, count));
      }
      const output = await git(["log", `--max-count=${clampedCount}`, "--format=%H|%an|%ai|%s"], cwd);
      if (!output) return [];
      return output.split("\n").filter(Boolean).map((line) => {
        const [hash, author, date, ...rest] = line.split("|");
        return { hash: hash?.slice(0, 12) ?? "", author: author ?? "", date: date ?? "", subject: rest.join("|") ?? "" };
      });
    })
  );

  // ── git diff (for commit message generation) ───────────────────────────
  registerIpcHandle("git:diff", (_e, { cwd, staged }: { cwd: string; staged?: boolean }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      const args = staged ? ["diff", "--cached", "--unified=3"] : ["diff", "HEAD", "--unified=3"];
      const result = await gitSafe(args, cwd);
      if (result.status !== 0) {
        const fallback = await gitSafe(["diff", "--cached", "--unified=3"], cwd);
        return fallback.stdout || "";
      }
      return result.stdout || "";
    })
  );

  // ── git diffBranch (diff of current branch against a base branch) ──────
  registerIpcHandle("git:diffBranch", (_e, { cwd, baseBranch }: { cwd: string; baseBranch: string }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      if (baseBranch.startsWith("-")) {
        throw new Error(`Invalid branch name: ${baseBranch}`);
      }
      const checkBranch = await gitSafe(["check-ref-format", "--branch", baseBranch], cwd);
      if (checkBranch.status !== 0) {
        throw new Error(`Invalid branch name: ${baseBranch}`);
      }
      const args = ["diff", `origin/${baseBranch}...HEAD`, "--unified=3"];
      const result = await gitSafe(args, cwd);
      if (result.status !== 0) {
        const fallback = await gitSafe(["diff", `${baseBranch}...HEAD`, "--unified=3"], cwd);
        return fallback.stdout || "";
      }
      return result.stdout || "";
    })
  );

  // ── git diffFile (stat + full diff for one file) ───────────────────────
  registerIpcHandle("git:diffFile", (_e, { cwd, filePath, staged }: { cwd: string; filePath: string; staged?: boolean }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      if (!isSafePathspec(filePath) || !isPathWithinCwd(cwd, filePath)) {
        throw new Error(`Access denied: path is outside the code directory: ${filePath}`);
      }

      let diff: string;
      let statStdout = "";
      const literalFilePath = `:(literal)${filePath}`;
      if (staged) {
        statStdout = (await gitSafe(["diff", "--cached", "--numstat", "--", literalFilePath], cwd)).stdout;
        diff = (await gitSafe(["diff", "--cached", "--unified=10", "--", literalFilePath], cwd)).stdout;
      } else {
        const r = await gitSafe(["diff", "HEAD", "--unified=10", "--", literalFilePath], cwd);
        diff = r.stdout || "";
        if (diff) {
          statStdout = (await gitSafe(["diff", "HEAD", "--numstat", "--", literalFilePath], cwd)).stdout;
        } else {
          // If empty, file might be untracked — diff against /dev/null
          const untracked = await gitSafe(["diff", "--no-index", "--unified=10", "--", "/dev/null", filePath], cwd);
          diff = untracked.stdout || "";
          if (diff) {
            statStdout = (await gitSafe(["diff", "--no-index", "--numstat", "--", "/dev/null", filePath], cwd)).stdout;
          }
        }
      }
      const match = statStdout.match(/^(\d+)\s+(\d+)/);
      const added = match ? Number(match[1]) : 0;
      const deleted = match ? Number(match[2]) : 0;

      return { stat: { added, deleted }, diff: diff || "" };
    })
  );

  // ── git createPr ─────────────────────────────────────────────────────────
  registerIpcHandle("git:createPr", (_e, { cwd, title, body, base }: { cwd: string; title: string; body?: string; base?: string }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      let hasGh = false;
      try {
        await new Promise<void>((resolve, reject) => {
          execFile("gh", ["--version"], { timeout: 5_000 }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        hasGh = true;
      } catch {
        hasGh = false;
      }
      if (!hasGh) {
        throw new Error("GitHub CLI (`gh`) is not installed or not in PATH. Install it from https://cli.github.com/ to create PRs.");
      }
      const ghArgs = ["pr", "create", "--title", title, "--head", branch];
      if (body) ghArgs.push("--body", body);
      if (base) ghArgs.push("--base", base);
      const result = await new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve) => {
        execFile("gh", ghArgs, { cwd, encoding: "utf-8", timeout: 30_000 }, (error, stdout, stderr) => {
          const code = error ? (error as { code?: number | string }).code : 0;
          const status = typeof code === "number" ? code : (error ? 1 : 0);
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            status,
          });
        });
      });
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || "gh pr create failed");
      }
      const url = result.stdout.trim();
      return { url, branch };
    })
  );

  // ── git prStatus (check if a PR exists for the current branch) ───────────
  registerIpcHandle("git:prStatus", (_e, { cwd }: { cwd: string }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      let hasGh = false;
      try {
        await new Promise<void>((resolve, reject) => {
          execFile("gh", ["--version"], { timeout: 5_000 }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        hasGh = true;
      } catch {
        hasGh = false;
      }
      if (!hasGh) {
        return null;
      }
      const branch = (await gitSafe(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).stdout;
      if (!branch) return null;
      const result = await new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve) => {
        execFile("gh", ["pr", "view", branch, "--json", "url,state,title"], { cwd, encoding: "utf-8", timeout: 10_000 }, (error, stdout, stderr) => {
          const code = error ? (error as { code?: number | string }).code : 0;
          const status = typeof code === "number" ? code : (error ? 1 : 0);
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            status,
          });
        });
      });
      if (result.status !== 0) {
        return null;
      }
      try {
        const parsed = JSON.parse(result.stdout);
        return {
          url: parsed.url || null,
          state: parsed.state || null,
          title: parsed.title || null,
        };
      } catch {
        return null;
      }
    })
  );

  // ── git stash / stash pop ───────────────────────────────────────────────
  registerIpcHandle("git:stash", (_e, { cwd, action }: { cwd: string; action: "push" | "pop" | "list" }) =>
    handle(async () => {
      assertWithinCodeDirectory(db, cwd);
      const allowedActions = ["push", "pop", "list"];
      if (!allowedActions.includes(action)) {
        throw new Error(`Invalid stash action: ${action}`);
      }
      if (action === "list") {
        const output = await git(["stash", "list"], cwd);
        return output ? output.split("\n").filter(Boolean) : [];
      }
      await git(["stash", action], cwd);
      return { ok: true };
    })
  );
}
