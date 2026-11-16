/**
 * Git execution helpers (F6): one home for running `git`, shared by the
 * `git:*` IPC handlers and the agent diff view.
 */

import { execFile } from "node:child_process";
import path from "node:path";

/** Packaged apps miss the user's brew paths; git lives in /opt/homebrew or /usr/local on macOS. */
export function gitExecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform === "darwin") {
    const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
    const currentPath = env.PATH || "";
    env.PATH = extraPaths
      .concat(currentPath.split(path.delimiter))
      .filter(Boolean)
      .join(path.delimiter);
  }
  return env;
}

const MAX_BUFFER = 20 * 1024 * 1024; // 20MB

/** Run git, resolving stdout; rejects with stderr (or the exit status) on failure. */
export function git(args: string[], cwd: string, timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf-8", timeout, maxBuffer: MAX_BUFFER, env: gitExecEnv() }, (error, stdout, stderr) => {
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

/** Run git, never rejecting: the exit status travels with the output. */
export function gitSafe(args: string[], cwd: string, timeout = 15_000): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf-8", timeout, maxBuffer: MAX_BUFFER, env: gitExecEnv() }, (error, stdout, stderr) => {
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
