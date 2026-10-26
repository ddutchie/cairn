/**
 * PATH for local stdio MCP servers.
 *
 * A packaged app launched from the Start menu / Dock / launcher inherits a
 * minimal PATH, not the one from the user's shell. Version managers (fnm,
 * nvm, Volta, asdf) only add Node to PATH inside an activated shell, so a
 * server like `workiq` (an npm shim that runs `node …`) works from `npm run
 * dev` but dies with "Connection closed" in the release. We append the places
 * a runtime normally lives — the registry PATH on Windows, well-known version
 * manager "default" dirs everywhere — *after* the inherited entries, so an
 * explicit user PATH always wins.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isWin = process.platform === "win32";
const SEP = isWin ? ";" : ":";

function expandWinVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (m, name: string) => {
    const hit = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return hit ? (env[hit] ?? m) : m;
  });
}

/** Machine + user PATH as stored in the registry (what a fresh login would see). */
function readWindowsRegistryPath(env: NodeJS.ProcessEnv): string[] {
  const keys = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];
  const out: string[] = [];
  for (const key of keys) {
    try {
      const text = execFileSync("reg", ["query", key, "/v", "Path"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = text.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im);
      if (m) out.push(...expandWinVars(m[1].trim(), env).split(";"));
    } catch {
      // key/value missing or reg.exe unavailable — skip
    }
  }
  return out;
}

function newestChildDir(dir: string, sub: string): string | null {
  try {
    const names = fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const n of names) {
      const p = path.join(dir, n, sub);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // dir absent
  }
  return null;
}

/** Version-manager / tool dirs that hold a default `node` (only those that exist). */
function wellKnownDirs(env: NodeJS.ProcessEnv): string[] {
  const home = os.homedir();
  const dirs: Array<string | null> = [];
  if (isWin) {
    const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const fnmDir = env.FNM_DIR ?? path.join(appData, "fnm");
    dirs.push(
      path.join(fnmDir, "aliases", "default"),
      path.join(local, "Volta", "bin"),
      env.NVM_SYMLINK ?? null,
      path.join(appData, "npm"),
      path.join(home, ".bun", "bin"),
    );
  } else {
    const fnmDir = env.FNM_DIR ?? path.join(home, process.platform === "darwin" ? "Library/Application Support/fnm" : ".local/share/fnm");
    dirs.push(
      path.join(fnmDir, "aliases", "default", "bin"),
      path.join(home, ".volta", "bin"),
      newestChildDir(path.join(env.NVM_DIR ?? path.join(home, ".nvm"), "versions", "node"), "bin"),
      path.join(home, ".asdf", "shims"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    );
  }
  return dirs.filter((d): d is string => !!d && fs.existsSync(d));
}

/**
 * `base` PATH plus any missing runtime dirs, inherited entries first.
 * Exported with injectable inputs for tests; use {@link stdioPath} at runtime.
 */
export function augmentPath(basePath: string | undefined, extra: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...(basePath ?? "").split(SEP), ...extra]) {
    const e = entry.trim();
    if (!e) continue;
    const key = isWin ? e.toLowerCase().replace(/[\\/]+$/, "") : e;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.join(SEP);
}

let cached: string | null = null;

/** PATH to hand to a stdio MCP child (memoised — the registry read shells out). */
export function stdioPath(env: NodeJS.ProcessEnv = process.env): string {
  if (cached !== null && env === process.env) return cached;
  const base = env.PATH ?? env.Path;
  const extra = [...(isWin ? readWindowsRegistryPath(env) : []), ...wellKnownDirs(env)];
  const result = augmentPath(base, extra);
  if (env === process.env) cached = result;
  return result;
}
