/**
 * Typed client for the coding-agent bridge (`agent:*`): agents, file access,
 * codebase index and PTYs. Every failure rejects with the main-process
 * message; off-Electron calls reject with `IpcUnavailableError`.
 */

import type {
  AgentSpawnInput,
  CodingAgentInput,
  ModelPtyEvent,
  PtyDataEvent,
  PtyExitEvent,
} from "../../../shared/types/coding-agent";
import { domainCall, type ElectronApi } from "./client";

type AgentApi = NonNullable<ElectronApi["agent"]>;
const agent = <T>(fn: (api: AgentApi) => Promise<T>) => domainCall("agent", fn);

export const agentClient = {
  getCodingAgents: () => agent((a) => a.getCodingAgents()),
  saveCodingAgent: (input: CodingAgentInput) => agent((a) => a.saveCodingAgent(input)),
  deleteCodingAgent: (id: string) => agent((a) => a.deleteCodingAgent(id)),
  setDefaultAgent: (id: string) => agent((a) => a.setDefaultAgent(id)),

  readDir: (dirPath: string) => agent((a) => a.readDir(dirPath)),
  revealPath: (targetPath: string) => agent((a) => a.revealPath(targetPath)),
  searchFiles: (dirPath: string, query: string) => agent((a) => a.searchFiles(dirPath, query)),
  readFile: (filePath: string) => agent((a) => a.readFile(filePath)),
  readFileBase64: (filePath: string) => agent((a) => a.readFileBase64(filePath)),
  writeFile: (filePath: string, content: string) => agent((a) => a.writeFile(filePath, content)),
  validateDirectory: (dirPath: string) => agent((a) => a.validateDirectory(dirPath)),
  gitDiff: (cwd: string) => agent((a) => a.gitDiff(cwd)),

  codebaseOverview: (folder: string) => agent((a) => a.codebaseOverview(folder)),
  codebaseGraph: (folder: string) => agent((a) => a.codebaseGraph(folder)),
  codebaseModuleGraph: (folder: string, depth?: number) => agent((a) => a.codebaseModuleGraph(folder, depth)),
  codebaseFileSymbols: (filePath: string) => agent((a) => a.codebaseFileSymbols(filePath)),
  codebaseRelations: (name: string, folder?: string) => agent((a) => a.codebaseRelations(name, folder)),
  codebaseReindex: (folder: string) => agent((a) => a.codebaseReindex(folder)),
  codebaseReindexFile: (folder: string, filePath: string) =>
    agent((a) => a.codebaseReindexFile(folder, filePath)),
  /** null when cancelled. */
  pickDirectory: () => agent((a) => a.pickDirectory()),
  pickFile: () => agent((a) => a.pickFile()),

  spawn: (input: AgentSpawnInput) => agent((a) => a.spawn(input)),
  spawnShell: (cwd: string) => agent((a) => a.spawnShell(cwd)),
  input: (sessionId: string, data: string) => agent((a) => a.input(sessionId, data)),
  resize: (sessionId: string, cols: number, rows: number) => agent((a) => a.resize(sessionId, cols, rows)),
  kill: (sessionId: string) => agent((a) => a.kill(sessionId)),

  modelTerminals: () => agent((a) => a.modelTerminals()),
  /** Subscribe to model-terminal events; returns the unsubscribe function (a no-op off-Electron). */
  onModelTerminal: (cb: (e: ModelPtyEvent) => void): (() => void) =>
    window.electron?.agent?.onModelTerminal?.(cb) ?? (() => {}),
  /** Subscribe to PTY output; returns the unsubscribe function (a no-op off-Electron). */
  onData: (cb: (payload: PtyDataEvent) => void): (() => void) =>
    window.electron?.agent?.onData?.(cb) ?? (() => {}),
  /** Subscribe to PTY exits; returns the unsubscribe function (a no-op off-Electron). */
  onExit: (cb: (payload: PtyExitEvent) => void): (() => void) =>
    window.electron?.agent?.onExit?.(cb) ?? (() => {}),
};
