/** Workspace-persistent "Always allow" tool approvals. */

export interface ApprovalGrant {
  id: string;
  workspaceId: string;
  tool: string;
  /** Canonicalized bash command, or the tool's primary target, when the grant is target-scoped. */
  target: string | null;
  createdAt: string;
}
