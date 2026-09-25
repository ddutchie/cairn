/**
 * Cairn — Database row mappers and helpers
 * Shared between Electron main process (queries.ts) and MCP process (db.ts)
 * to avoid duplication and schema discrepancies.
 */

import { stripMarkdown } from "./text-utils";
import { noteExcerpt } from "../../shared/notes/excerpt";

/** A raw SQLite row: column names → values. Mappers cast fields explicitly. */
export type DbRow = Record<string, unknown>;

// ── JSON & Data parsing helpers ──────────────────────────────────────────────

export function j(v: unknown): string {
  return JSON.stringify(v ?? []);
}

export function j2(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  try {
    return JSON.parse(v) as string[];
  } catch {
    return [];
  }
}

export function p(v: unknown): unknown[] {
  if (typeof v !== "string" || !v) return [];
  try {
    return JSON.parse(v) as unknown[];
  } catch {
    return [];
  }
}

export function b(v: unknown): boolean {
  return v === 1;
}

// ── Row -> Domain Type Mappers ───────────────────────────────────────────────

export function toWorkspace(row: DbRow) {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | undefined,
    icon: row.icon as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | undefined,
  };
}

export function toProject(row: DbRow) {
  const raw = row.project_settings as string | undefined;
  let projectSettings: Record<string, unknown> = {};
  if (raw) {
    try { projectSettings = JSON.parse(raw); } catch { projectSettings = {}; }
  }
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    description: row.description as string | undefined,
    icon: row.icon as string | undefined,
    status: row.status as string,
    priority: row.priority as string,
    dueDate: row.due_date as string | undefined,
    tagIds: p(row.tag_ids) as string[],
    codeDirectory: row.code_directory as string | null ?? null,
    projectSettings,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | undefined,
  };
}

export function toCodingAgent(row: DbRow) {
  return {
    id: row.id as string,
    name: row.name as string,
    binaryPath: row.binary_path as string,
    args: row.args as string,
    isDefault: row.is_default === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Parse a JSON object column, falling back to {} on null/invalid. */
function pObj(v: unknown): Record<string, string> {
  if (typeof v !== "string" || !v) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Parse the custom-service `oauth_config` JSON blob. Returns undefined when
 * absent/invalid so the field is simply omitted from the config object (matching
 * the optional `oauth?` type), rather than surfacing an empty object.
 */
function parseOAuthConfig(v: unknown):
  | { serverUrl?: string; scope?: string; clientId?: string; redirectUri?: string; authorizationUrl?: string; tokenUrl?: string }
  | undefined {
  if (typeof v !== "string" || !v) return undefined;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function toMcpServer(row: DbRow) {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    description: (row.description ?? undefined) as string | undefined,
    transport: (row.transport ?? "http") as "sse" | "http",
    baseUrl: row.base_url as string,
    headers: pObj(row.headers),
    authMode: (row.auth_mode ?? "none") as "none" | "oauth",
    oauthScope: (row.oauth_scope ?? undefined) as string | undefined,
    oauthClientId: (row.oauth_client_id ?? undefined) as string | undefined,
    oauthRedirectUri: (row.oauth_redirect_uri ?? undefined) as string | undefined,
    oauthClientIdRequired: row.oauth_client_id_required === 1,
    /** Dev-only: route this server through dsh-mcp-client (parity spike). */
    dshPath: row.dsh_path === 1,
    enabled: row.enabled === 1,
    source: (row.source ?? "manual") as "manual" | "community" | "ai-builder",
    communityId: (row.community_id ?? undefined) as string | undefined,
    version: (row.version ?? undefined) as string | undefined,
    disabledTools: j2(row.disabled_tools),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toCustomService(row: DbRow) {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    description: (row.description ?? undefined) as string | undefined,
    apiUrl: row.api_url as string,
    method: (row.method ?? "GET") as "GET" | "POST" | "PUT" | "DELETE",
    headers: pObj(row.headers),
    toolDefinition: row.tool_definition as string,
    baseUrl: (row.base_url ?? undefined) as string | undefined,
    operations: row.operations ? (j2(row.operations) as unknown[]) : undefined,
    responseKeys: j2(row.response_keys),
    apiKeyUrl: (row.api_key_url ?? undefined) as string | undefined,
    authMode: (row.auth_mode ?? "none") as "none" | "oauth",
    oauth: parseOAuthConfig(row.oauth_config),
    enabled: row.enabled === 1,
    source: (row.source ?? "manual") as "manual" | "community" | "ai-builder",
    communityId: (row.community_id ?? undefined) as string | undefined,
    version: (row.version ?? undefined) as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toToolAttachment(row: DbRow) {
  return {
    projectId: row.project_id as string,
    toolType: row.tool_type as "mcp" | "service",
    toolId: row.tool_id as string,
    enabled: row.enabled === 1,
  };
}

export function toNote(row: DbRow) {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string,
    content: (row.content ?? "") as string,
    // Short plain-text excerpt for previews (see shared/notes/excerpt.ts) —
    // NOT a full mirror; full-text search derives it from `content`.
    // Dashboards keep an empty excerpt as before.
    contentText: noteExcerpt(row.content as string | null, row.type as string | null, stripMarkdown),
    tagIds: p(row.tag_ids) as string[],
    linkedNoteIds: p(row.linked_note_ids) as string[],
    linkedCardIds: p(row.linked_card_ids) as string[],
    isPinned: b(row.is_pinned),
    type: (row.type ?? "note") as "note" | "dashboard" | "template",
    folder: (row.folder ?? "") as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | undefined,
    deletedAt: (row.deleted_at ?? undefined) as string | undefined,
    version: (row.version ?? 0) as number,
  };
}

export function toColumn(row: DbRow) {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    type: row.type as string,
    order: row.order as number,
    cardLimit: row.card_limit as number | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toCard(row: DbRow) {
  return {
    id: row.id as string,
    columnId: row.column_id as string,
    projectId: row.project_id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    tagIds: p(row.tag_ids) as string[],
    priority: row.priority as string,
    dueDate: row.due_date as string | undefined,
    linkedNoteIds: p(row.linked_note_ids) as string[],
    blockedByIds: p(row.blocked_by_ids) as string[],
    order: row.order as number,
    assignee: row.assignee as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | undefined,
    version: (row.version ?? 0) as number,
  };
}

export function toTag(row: DbRow) {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    color: row.color as string,
  };
}

export function toSlashCommand(row: DbRow) {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    description: (row.description ?? "") as string,
    insertText: (row.insert_text ?? "") as string,
    scope: (row.scope ?? "both") as "chat" | "agent" | "both",
    source: (row.source ?? "custom") as "custom" | "community",
    communityId: (row.community_id ?? undefined) as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toChatThread(row: DbRow) {
  return {
    id: row.id as string,
    scope: row.scope as string,
    workspaceId: row.workspace_id as string,
    projectId: row.project_id as string | undefined,
    title: row.title as string | undefined,
    useSubagents: row.use_subagents ? true : false,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toChatMessage(row: DbRow) {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    role: row.role as string,
    content: row.content as string,
    reasoning: (row.reasoning as string | null) ?? undefined,
    reasoningSummary: (row.reasoning_summary as string | null) ?? undefined,
    reasoningItems: row.reasoning_items ? JSON.parse(row.reasoning_items as string) : undefined,
    reasoningField: (row.reasoning_field as string | null) ?? undefined,
    reasoningModel: (row.reasoning_model as string | null) ?? undefined,
    contextRefs: row.context_refs ? JSON.parse(row.context_refs as string) : undefined,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls as string) : undefined,
    subagents: row.subagents ? JSON.parse(row.subagents as string) : undefined,
    createdAt: row.created_at as string,
  };
}

/** The complete set of notification navigation-target types. */
export const NOTIFICATION_TARGET_TYPES = ["note", "task", "automation", "approval"] as const;
export type NotificationTargetType = (typeof NOTIFICATION_TARGET_TYPES)[number];

export interface McpNotification {
  id: string;
  tool: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  /** Optional navigation target (note/task/automation/approval) the notification links to. */
  targetType: NotificationTargetType | null;
  targetId: string | null;
}

export function toMcpNotification(row: DbRow): McpNotification {
  return {
    id: row.id as string,
    tool: row.tool as string,
    title: row.title as string,
    body: row.body as string,
    read: b(row.read),
    createdAt: row.created_at as string,
    targetType: (NOTIFICATION_TARGET_TYPES as readonly string[]).includes(row.target_type as string) ? (row.target_type as NotificationTargetType) : null,
    targetId: row.target_id ? (row.target_id as string) : null,
  };
}

export function toIdeaFlow(row: DbRow) {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toIdeaFlowNode(row: DbRow) {
  return {
    id: row.id as string,
    flowId: row.flow_id as string,
    type: row.type as string,
    x: row.x as number,
    y: row.y as number,
    width: row.width as number | undefined,
    height: row.height as number | undefined,
    parentId: row.parent_id as string | undefined,
    data: (() => {
      try {
        return JSON.parse(row.data as string);
      } catch {
        return {};
      }
    })(),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toIdeaFlowEdge(row: DbRow) {
  return {
    id: row.id as string,
    flowId: row.flow_id as string,
    sourceNodeId: row.source_node_id as string,
    targetNodeId: row.target_node_id as string,
    label: row.label as string | undefined,
    createdAt: row.created_at as string,
  };
}
