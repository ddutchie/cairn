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
  projectName?: string;
  projectDescription?: string;
  cwd?: string;
  activeNotePath?: string;
  activeColumn?: string;
  focusedTaskTitle?: string;
  gitBranch?: string;
}

let currentContextInfo: WorkspaceContextInfo = {};

export function updateWorkspaceContext(info: Partial<WorkspaceContextInfo>): void {
  currentContextInfo = { ...currentContextInfo, ...info };
}

export function getWorkspaceContext(): WorkspaceContextInfo {
  return currentContextInfo;
}

export function clearWorkspaceContext(): void {
  currentContextInfo = {};
}

export function mountWorkspaceContext(ctx: Context): void {
  (ctx as unknown as { inject: (deps: string[], fn: (c: unknown) => void) => void }).inject(
    ["systemPrompt"],
    (c: unknown) => {
      const sp = (c as { systemPrompt: { context: (spec: { name: string; order?: number; text: () => string }) => void } }).systemPrompt;
      if (!sp || typeof sp.context !== "function") return;

      sp.context({
        name: "cairn:workspace",
        order: 100,
        text: () => {
          const lines: string[] = [];
          const { workspaceName, projectName, projectDescription, cwd, activeNotePath, activeColumn, focusedTaskTitle, gitBranch } = currentContextInfo;
          if (workspaceName) lines.push(`Workspace: ${workspaceName}`);
          if (projectName) lines.push(`Project: ${projectName}${projectDescription ? ` (${projectDescription})` : ""}`);
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
