/**
 * Typed client for app-shell channels (`app:*`, `updater:*`, `spellcheck:*`).
 * These live at the top level of the bridge (no namespace object).
 * Every failure rejects with the main-process message; off-Electron calls
 * reject with `IpcUnavailableError`.
 */
import type {
  MigrationProgress,
  UpdateAvailableInfo,
} from "../../../shared/types/app";
import type { SpellcheckContext } from "../../../shared/ipc/contract";
import { electronCall, type ElectronApi } from "./client";

const app = <T>(fn: (api: ElectronApi) => Promise<T>) => electronCall(fn);

export const appClient = {
  mcpServerPath: () => app((e) => e.mcpServerPath()),
  latestChangelog: () => app((e) => e.latestChangelog()),
  /** Open a URL in the system default browser. Fire-and-forget. */
  openExternal: (url: string): Promise<void> =>
    electronCall((e) => { e.openExternal(url); return Promise.resolve(); }),
  /** Orphaned GGUFs/binaries from the retired on-device LLM engine. */
  llmLeftovers: () => app((e) => e.llmLeftovers()),
  clearLlmLeftovers: () => app((e) => e.clearLlmLeftovers()),
  /** Open the folder containing pasted images. */
  revealAssets: () => app((e) => e.revealAssets()),

  selectWorkspaceFolder: () => app((e) => e.selectWorkspaceFolder()),
  getWorkspacePath: () => app((e) => e.getWorkspacePath()),
  needsWorkspaceSetup: () => app((e) => e.needsWorkspaceSetup()),
  /** True when running unpackaged — gates dev-only UI. */
  isDev: () => app((e) => e.isDev()),
  setTheme: (theme: string) => app((e) => e.setTheme(theme)),
  setAccent: (accent: string) => app((e) => e.setAccent(accent)),
  initWorkspace: (workspacePath: string, excludedFolders?: string[]) =>
    app((e) => e.initWorkspace(workspacePath, excludedFolders)),
  rescanWorkspace: (workspaceId?: string, excludedFolders?: string[], reimport?: boolean) =>
    app((e) => e.rescanWorkspace(workspaceId, excludedFolders, reimport)),
  rollbackImport: (projectIds: string[]) => app((e) => e.rollbackImport(projectIds)),
  probeWorkspaceFolder: (folder: string) => app((e) => e.probeWorkspaceFolder(folder)),
  relaunch: () => app((e) => e.relaunch()),
  resetAllData: () => app((e) => e.resetAllData()),
  getAiSettings: () => app((e) => e.getAiSettings()),
  saveAiSettings: (config: Record<string, unknown>) => app((e) => e.saveAiSettings(config)),
  getAgentSettings: () => app((e) => e.getAgentSettings()),
  saveAgentSettings: (config: Record<string, unknown>) => app((e) => e.saveAgentSettings(config)),
  getTheme: () => app((e) => e.getTheme()),
  saveTheme: (theme: string) => app((e) => e.saveTheme(theme)),
  getFontScale: () => app((e) => e.getFontScale()),
  saveFontScale: (fontScale: number) => app((e) => e.saveFontScale(fontScale)),

  /** Global quick-capture shortcut / tray item fired. */
  onQuickCapture: (cb: () => void): (() => void) =>
    window.electron?.onQuickCapture?.(cb) ?? (() => {}),

  /** Right-click suggestions. */
  onSpellcheckContext: (cb: (e: SpellcheckContext) => void): (() => void) =>
    window.electron?.onSpellcheckContext?.(cb) ?? (() => {}),
  spellcheckReplace: (word: string) => app((e) => e.spellcheckReplace(word)),
  spellcheckAddWord: (word: string) => app((e) => e.spellcheckAddWord(word)),

  checkMigrations: () => app((e) => e.checkMigrations()),
  runMigration: (migrationId: string) => app((e) => e.runMigration(migrationId)),
  onMigrationProgress: (cb: (e: MigrationProgress) => void): (() => void) =>
    window.electron?.onMigrationProgress?.(cb) ?? (() => {}),

  updater: {
    install: () => app((e) => e.updater.install()),
    onUpdateAvailable: (cb: (info: UpdateAvailableInfo) => void): (() => void) =>
      window.electron?.updater?.onUpdateAvailable?.(cb) ?? (() => {}),
    onUpdateDownloaded: (cb: () => void): (() => void) =>
      window.electron?.updater?.onUpdateDownloaded?.(cb) ?? (() => {}),
  },
};
