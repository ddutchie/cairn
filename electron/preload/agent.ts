/** Coding agents, file access, codebase index and PTYs. */

import { invokeContract, onIpcEvent } from "./ipc";
import type { AgentSpawnInput, CodingAgentInput, ModelPtyEvent, PtyDataEvent, PtyExitEvent } from "../../shared/types/coding-agent";

export const agentApi = {
  // ── Agent / coding sessions ───────────────────
  agent: {
    getCodingAgents: () => invokeContract("agent:getCodingAgents"),
    saveCodingAgent: (agent: CodingAgentInput) => invokeContract("agent:saveCodingAgent", agent),
    deleteCodingAgent: (id: string) => invokeContract("agent:deleteCodingAgent", { id }),
    setDefaultAgent: (id: string) => invokeContract("agent:setDefaultAgent", { id }),

    readDir: (dirPath: string) => invokeContract("agent:readDir", { dirPath }),
    searchFiles: (dirPath: string, query: string) => invokeContract("agent:searchFiles", { dirPath, query }),
    readFile: (filePath: string) => invokeContract("agent:readFile", { filePath }),
    readFileBase64: (filePath: string) => invokeContract("agent:readFileBase64", { filePath }),
    writeFile: (filePath: string, content: string) => invokeContract("agent:writeFile", { filePath, content }),
    validateDirectory: (dirPath: string) => invokeContract("agent:validateDirectory", { dirPath }),
    gitDiff: (cwd: string) => invokeContract("agent:gitDiff", { cwd }),
    // Codebase index (Architecture tab) — read-only views over the semantic index.
    codebaseOverview: (folder: string) => invokeContract("agent:codebaseOverview", { folder }),
    codebaseGraph: (folder: string) => invokeContract("agent:codebaseGraph", { folder }),
    codebaseModuleGraph: (folder: string, depth?: number) => invokeContract("agent:codebaseModuleGraph", { folder, depth }),
    codebaseFileSymbols: (filePath: string) => invokeContract("agent:codebaseFileSymbols", { filePath }),
    codebaseRelations: (name: string, folder?: string) => invokeContract("agent:codebaseRelations", { name, folder }),
    codebaseReindex: (folder: string) => invokeContract("agent:codebaseReindex", { folder }),
    codebaseReindexFile: (folder: string, filePath: string) =>
      invokeContract("agent:codebaseReindexFile", { folder, filePath }),
    /** null when cancelled. */
    pickDirectory: () => invokeContract("agent:pickDirectory"),
    pickFile: () => invokeContract("agent:pickFile"),

    spawn: (input: AgentSpawnInput) => invokeContract("agent:spawn", input),
    spawnShell: (cwd: string) => invokeContract("agent:spawnShell", { cwd }),
    input: (sessionId: string, data: string) => invokeContract("agent:input", { sessionId, data }),
    resize: (sessionId: string, cols: number, rows: number) => invokeContract("agent:resize", { sessionId, cols, rows }),
    kill: (sessionId: string) => invokeContract("agent:kill", { sessionId }),

    // Agent-owned (model) terminals — observe only.
    modelTerminals: () => invokeContract("agent:modelTerminals"),
    onModelTerminal: (cb: (e: ModelPtyEvent) => void) => onIpcEvent("agent:model-terminal", cb),

    onData: (cb: (payload: PtyDataEvent) => void) => onIpcEvent("agent:data", cb),
    onExit: (cb: (payload: PtyExitEvent) => void) => onIpcEvent("agent:exit", cb),
  },
} as const;
