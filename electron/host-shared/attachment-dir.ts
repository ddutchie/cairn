/**
 * Where a workspace keeps its attachment binaries (images/PDFs).
 *
 * Shared by `app:uploadAsset` (writes new attachments) and Device Sync
 * (publishes/fetches them), so both always agree on the folder. Honours an
 * Obsidian vault's `attachmentFolderPath` when the workspace is a vault;
 * otherwise `<workspace>/attachments`.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveWithinRoot } from "../ipc/path-safety";

export function resolveAttachmentDir(workspacePath: string): string {
  const fallback = path.join(workspacePath, "attachments");
  const obsidianAppJson = path.join(workspacePath, ".obsidian", "app.json");
  try {
    if (!fs.existsSync(obsidianAppJson)) return fallback;
    const obsConfig = JSON.parse(fs.readFileSync(obsidianAppJson, "utf-8"));
    if (typeof obsConfig.attachmentFolderPath === "string" && obsConfig.attachmentFolderPath) {
      return resolveWithinRoot(workspacePath, obsConfig.attachmentFolderPath) ?? fallback;
    }
  } catch {
    /* unreadable/invalid config — use the default */
  }
  return fallback;
}

/**
 * Locate an existing attachment by bare filename: the configured attachment
 * folder first, then the default `attachments/` and legacy `assets/` folders
 * (the same order the `asset://` protocol handler uses). Returns null if absent.
 * `name` must be a bare filename — anything with a path separator is rejected so
 * a hostile synced manifest can never point outside the workspace.
 */
export function findAttachmentFile(workspacePath: string, name: string): string | null {
  if (!name || name !== path.basename(name) || name.includes("\\") || name === "." || name === "..") return null;
  const dirs = [
    resolveAttachmentDir(workspacePath),
    path.join(workspacePath, "attachments"),
    path.join(workspacePath, "assets"),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}
