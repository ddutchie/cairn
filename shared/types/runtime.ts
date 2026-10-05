/**
 * Agent-runtime introspection (Settings → AI), slash-command execution and
 * Mobile Access status, shared by main, the typed IPC contract and the renderer.
 */

/** Result of running a dsh registry command (/plan, /compact, …). */
export interface CommandExecutionResult {
  kind?: string;
  text?: string;
  /** Set when the command switched the session's plan/execute mode. */
  mode?: "plan" | "execute";
}

/** The assembled dsh system prompt and its breakdown; `error` set when assembly failed. */
export interface SystemPromptPreview {
  text: string;
  sections: Array<{ name: string; order: number; text: string; index: number }>;
  contexts: Array<{ name: string; order: number; text: string }>;
  skills: Array<{ name: string; description: string }>;
  tools: Array<{ name: string; description?: string }>;
  variables: Record<string, string | undefined>;
  cairnSystemLive?: boolean;
  error?: string;
}

export type InventoryCategory = "read" | "write" | "delete" | "exec";
export type InventorySource = "cairn" | "coding" | "global";
export type InventorySurface = "chat" | "coding" | "automation-dev" | "mcp";

export interface InventoryTool {
  name: string;
  description: string;
  category: InventoryCategory;
  source: InventorySource;
  /** True when the tool registers but is approval-gated on that surface
   *  (chat's delete_note/delete_task/delete_project via askFilter). */
  gated?: boolean;
}

/** Per-surface tool inventory; `surfaces` is null and `error` set when it couldn't be built. */
export interface ToolInventory {
  surfaces: Record<InventorySurface, InventoryTool[]> | null;
  error?: string;
}

export interface MobileStatus {
  running: boolean;
  url: string;
  qrCode: string;
  pin: string;
}
