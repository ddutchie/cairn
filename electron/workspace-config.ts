/**
 * Cairn — Workspace folder configuration
 *
 * Persists the user-chosen workspace folder path to a small JSON file
 * inside the Electron userData directory. This is separate from cairn.db
 * (which now lives inside the workspace folder itself).
 *
 * File: <userData>/workspace-config.json
 * Shape: { "workspacePath": "/Users/foo/Documents/My Cairn" }
 */

import path from "path";
import fs from "fs";

const CONFIG_FILE = "workspace-config.json";

interface WorkspaceConfig {
  workspacePath: string;
}

export function getWorkspaceConfigPath(userDataPath: string): string {
  return path.join(userDataPath, CONFIG_FILE);
}

export function readWorkspaceConfig(userDataPath: string): WorkspaceConfig | null {
  const configPath = getWorkspaceConfigPath(userDataPath);
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(raw) as any;

    // Normal shape: { workspacePath: "/path/to/workspace" }
    if (typeof parsed.workspacePath === "string" && parsed.workspacePath.length > 0) {
      return parsed as WorkspaceConfig;
    }

    // Corrupted shape written by older builds: { workspacePath: { data: "/path" } }
    // Heal it automatically by re-writing the correct format.
    if (parsed.workspacePath && typeof parsed.workspacePath === "object" && typeof parsed.workspacePath.data === "string" && parsed.workspacePath.data.length > 0) {
      const healed: WorkspaceConfig = { workspacePath: parsed.workspacePath.data };
      fs.writeFileSync(configPath, JSON.stringify(healed, null, 2), "utf-8");
      return healed;
    }

    return null;
  } catch {
    return null;
  }
}

export function writeWorkspaceConfig(userDataPath: string, workspacePath: string): void {
  const configPath = getWorkspaceConfigPath(userDataPath);
  const config: WorkspaceConfig = { workspacePath };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Returns the path to cairn.db inside the workspace folder.
 * The DB lives at: <workspacePath>/cairn.db
 */
export function getDbPathForWorkspace(workspacePath: string): string {
  return path.join(workspacePath, "cairn.db");
}
