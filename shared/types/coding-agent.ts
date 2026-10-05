/**
 * External coding agents (CLI binaries run in a PTY), the agent file browser
 * and terminal sessions — shared by main, the typed IPC contract and the
 * renderer.
 */

export interface CodingAgent {
  id: string;
  name: string;
  binaryPath: string;
  /** CLI args; `{prompt}` is replaced by the prompt, else it is appended. */
  args: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CodingAgentInput = Omit<CodingAgent, "createdAt" | "updatedAt">;

/** One entry of a directory listing in the agent file tree. */
export interface DirEntry {
  name: string;
  type: "file" | "dir";
  path: string;
}

export interface FileSearchResult {
  name: string;
  path: string;
  /** Path relative to the searched directory, posix separators. */
  relativePath: string;
}

/** `agent:spawn`: run a coding agent on a task in the project's code directory. */
export interface AgentSpawnInput {
  agentId: string;
  projectId: string;
  cwd: string;
  prompt: string;
  taskId: string;
  taskTitle: string;
}

/** Output from a UI-owned PTY (agent run or shell), pushed on `agent:data`. */
export interface PtyDataEvent {
  sessionId: string;
  data: string;
}

/** A UI-owned PTY exited, pushed on `agent:exit`. */
export interface PtyExitEvent {
  sessionId: string;
  exitCode: number;
}

/** A live terminal the agent opened itself (terminal_* tools), with its scrollback. */
export interface ModelTerminal {
  sessionId: string;
  cwd: string;
  scrollback: string;
}

/** Lifecycle + output of agent-owned terminals, broadcast on `agent:model-terminal`. */
export type ModelPtyEvent =
  | { type: "spawn"; sessionId: string; cwd: string }
  | { type: "data"; sessionId: string; data: string }
  | { type: "exit"; sessionId: string; exitCode: number };
