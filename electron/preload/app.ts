/** App shell: paths, workspace folder, settings, theme, migrations, updater. */

import { invokeContract, onIpcEvent, sendContract } from "./ipc";
import type { MigrationProgress, UpdateAvailableInfo } from "../../shared/types/app";

export const appApi = {
  // ── App paths ─────────────────────────────────
  mcpServerPath: () => invokeContract("app:mcpServerPath"),
  latestChangelog: () => invokeContract("app:latestChangelog"),

  // ── Open a URL in the system default browser ──
  openExternal: (url: string) => sendContract("app:openExternal", url),
  /** Orphaned GGUFs/binaries from the retired built-in engine (Settings → Data). */
  llmLeftovers: () => invokeContract("app:llmLeftovers"),
  clearLlmLeftovers: () => invokeContract("app:clearLlmLeftovers"),

  // ── Workspace folder ──────────────────────────
  selectWorkspaceFolder: () => invokeContract("app:selectWorkspaceFolder"),
  getWorkspacePath: () => invokeContract("app:getWorkspacePath"),
  needsWorkspaceSetup: () => invokeContract("app:needsWorkspaceSetup"),
  /** True when running unpackaged — gates dev-only UI (MCP dsh-path toggle). */
  isDev: () => invokeContract("app:isDev"),
  setTheme: (theme: string) => invokeContract("app:setTheme", theme),
  setAccent: (accent: string) => invokeContract("app:setAccent", accent),
  initWorkspace: (workspacePath: string, excludedFolders?: string[]) =>
    invokeContract("app:initWorkspace", { workspacePath, excludedFolders }),
  rescanWorkspace: (workspaceId?: string, excludedFolders?: string[]) =>
    invokeContract("app:rescanWorkspace", { workspaceId, excludedFolders }),
  rollbackImport: (projectIds: string[]) => invokeContract("app:rollbackImport", { projectIds }),
  probeWorkspaceFolder: (folder: string) => invokeContract("app:probeWorkspaceFolder", { folder }),
  relaunch: () => invokeContract("app:relaunch"),
  resetAllData: () => invokeContract("app:reset"),
  getAiSettings: () => invokeContract("app:getAiSettings"),
  saveAiSettings: (config: Record<string, unknown>) => invokeContract("app:saveAiSettings", { config }),
  getAgentSettings: () => invokeContract("app:getAgentSettings"),
  saveAgentSettings: (config: Record<string, unknown>) => invokeContract("app:saveAgentSettings", { config }),
  getTheme: () => invokeContract("app:getTheme"),
  saveTheme: (theme: string) => invokeContract("app:saveTheme", { theme }),
  getFontScale: () => invokeContract("app:getFontScale"),
  saveFontScale: (fontScale: number) => invokeContract("app:saveFontScale", { fontScale }),
  platform: process.platform as "darwin" | "win32" | "linux",

  /** Global quick-capture shortcut / tray item fired — open the capture dialog. */
  onQuickCapture: (cb: () => void) => onIpcEvent("app:quick-capture", cb),

  // ── Migrations ────────────────────────────────
  checkMigrations: () => invokeContract("app:checkMigrations"),
  runMigration: (migrationId: string) => invokeContract("app:runMigration", { migrationId }),
  onMigrationProgress: (cb: (e: MigrationProgress) => void) => onIpcEvent("app:migrationProgress", cb),

  // ── Auto-updater ──────────────────────────────
  updater: {
    onUpdateAvailable: (cb: (info: UpdateAvailableInfo) => void) => onIpcEvent("updater:update-available", cb),
    onUpdateDownloaded: (cb: () => void) => onIpcEvent("updater:update-downloaded", cb),
    install: () => invokeContract("updater:install"),
  },
} as const;
