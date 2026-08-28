/**
 * cairn:workspace-context — dynamic runtime context provider.
 *
 * Registers a dynamic context on `ctx.systemPrompt` that supplies the current
 * workspace/project info, active note, active board column, and git branch to
 * DSH's native `user/form:snapshot` messages.
 */
import type { Context } from "@deepseek-ai/cordis";

export interface WorkspaceContextInfo {
  workspaceName?: string;
  workspaceId?: string;
  projectName?: string;
  projectId?: string;
  projectDescription?: string;
  cwd?: string;
  activeNotePath?: string;
  activeColumn?: string;
  focusedTaskTitle?: string;
  gitBranch?: string;
}

const contextBySession = new Map<string, WorkspaceContextInfo>();

export function updateWorkspaceContext(sessionId: string, info: Partial<WorkspaceContextInfo>): void {
  contextBySession.set(sessionId, { ...contextBySession.get(sessionId), ...info });
}

export function getWorkspaceContext(sessionId: string): WorkspaceContextInfo {
  return contextBySession.get(sessionId) ?? {};
}

export function clearWorkspaceContext(sessionId: string): void {
  contextBySession.delete(sessionId);
}

export function mountWorkspaceContext(ctx: Context): void {
  (ctx as unknown as { inject: (deps: string[], fn: (c: unknown) => void) => void }).inject(
    ["systemPrompt"],
    (c: unknown) => {
      const sp = (c as { systemPrompt: { context: (spec: { name: string; order?: number; text: (assembly?: { agent?: { session?: { id?: unknown } } }) => string }) => void } }).systemPrompt;
      if (!sp || typeof sp.context !== "function") return;

      sp.context({
        name: "cairn:workspace",
        order: 100,
        text: (assembly?: { agent?: { session?: { id?: unknown } } }) => {
          const lines: string[] = [];
          const sessionId = String(assembly?.agent?.session?.id ?? "");
          const currentContextInfo = contextBySession.get(sessionId) ?? {};
          const { workspaceName, workspaceId, projectName, projectId, projectDescription, cwd, activeNotePath, activeColumn, focusedTaskTitle, gitBranch } = currentContextInfo;
          if (workspaceName) lines.push(`Workspace: ${workspaceName}${workspaceId ? ` (${workspaceId})` : ""}`);
          if (projectName) lines.push(`Project: ${projectName}${projectId ? ` (${projectId})` : ""}${projectDescription ? ` — ${projectDescription}` : ""}`);
          if (cwd) lines.push(`Working Directory: ${cwd}`);
          if (activeNotePath) lines.push(`Active Note: ${activeNotePath}`);
          if (activeColumn) lines.push(`Active Kanban Column: ${activeColumn}`);
          if (focusedTaskTitle) lines.push(`Focused Task: ${focusedTaskTitle}`);
          if (gitBranch) lines.push(`Git Branch: ${gitBranch}`);
          return lines.join("\n");
        },
      });
    },
  );
}
