/**
 * Cairn Mobile — DB query helpers
 *
 * All reads are via expo-sqlite async API.
 * JSON columns (tag_ids, linked_note_ids, etc.) are parsed here.
 */

import { getDb } from "./client";
import type { SQLiteBindValue } from "expo-sqlite";
import type {
  Workspace,
  Project,
  Note,
  BoardColumn,
  TaskCard,
  Tag,
  ChatThread,
  ChatMessage,
} from "../../src/types/index";

// ── Row → Domain type helpers ─────────────────────────────────────────────────

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToWorkspace(row: Record<string, unknown>): Workspace {
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

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    description: row.description as string | undefined,
    icon: row.icon as string | undefined,
    status: row.status as Project["status"],
    priority: row.priority as Project["priority"],
    dueDate: row.due_date as string | undefined,
    tagIds: parseJson<string[]>(row.tag_ids as string, []),
    codeDirectory: (row.code_directory as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | undefined,
  };
}

function rowToNote(row: Record<string, unknown>): Note {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string,
    content: (row.content as string) ?? "",
    contentText: (row.content_text as string) ?? "",
    tagIds: parseJson<string[]>(row.tag_ids as string, []),
    linkedNoteIds: parseJson<string[]>(row.linked_note_ids as string, []),
    linkedCardIds: parseJson<string[]>(row.linked_card_ids as string, []),
    isPinned: Boolean(row.is_pinned),
    type: (row.type as Note["type"]) ?? "note",
    folder: (row.folder as string) ?? "",
    version: (row.version as number) ?? 0,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | undefined,
  };
}

function rowToColumn(row: Record<string, unknown>): BoardColumn {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    type: row.type as BoardColumn["type"],
    order: row.order as number,
    cardLimit: row.card_limit as number | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToCard(row: Record<string, unknown>): TaskCard {
  return {
    id: row.id as string,
    columnId: row.column_id as string,
    projectId: row.project_id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    tagIds: parseJson<string[]>(row.tag_ids as string, []),
    priority: row.priority as TaskCard["priority"],
    dueDate: row.due_date as string | undefined,
    linkedNoteIds: parseJson<string[]>(row.linked_note_ids as string, []),
    blockedByIds: parseJson<string[]>(row.blocked_by_ids as string, []),
    order: row.order as number,
    assignee: row.assignee as string | undefined,
    version: (row.version as number) ?? 0,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | undefined,
  };
}

function rowToTag(row: Record<string, unknown>): Tag {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    color: row.color as string,
  };
}

function rowToThread(row: Record<string, unknown>): ChatThread {
  return {
    id: row.id as string,
    scope: row.scope as ChatThread["scope"],
    workspaceId: row.workspace_id as string,
    projectId: row.project_id as string | undefined,
    title: row.title as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    role: row.role as ChatMessage["role"],
    content: row.content as string,
    contextRefs: parseJson(row.context_refs as string | null, undefined),
    toolCalls: parseJson(row.tool_calls as string | null, undefined),
    createdAt: row.created_at as string,
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function getWorkspaces(): Promise<Workspace[]> {
  const db = getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY created_at ASC"
  );
  return rows.map(rowToWorkspace);
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const db = getDb();
  const row = await db.getFirstAsync<Record<string, unknown>>(
    "SELECT * FROM workspaces WHERE id = ?",
    [id]
  );
  return row ? rowToWorkspace(row) : null;
}

export async function getProjects(workspaceId: string): Promise<Project[]> {
  const db = getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM projects WHERE workspace_id = ? AND archived_at IS NULL ORDER BY updated_at DESC",
    [workspaceId]
  );
  return rows.map(rowToProject);
}

export async function getProject(id: string): Promise<Project | null> {
  const db = getDb();
  const row = await db.getFirstAsync<Record<string, unknown>>(
    "SELECT * FROM projects WHERE id = ?",
    [id]
  );
  return row ? rowToProject(row) : null;
}

export async function getColumns(projectId: string): Promise<BoardColumn[]> {
  const db = getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM board_columns WHERE project_id = ? ORDER BY "order" ASC`,
    [projectId]
  );
  return rows.map(rowToColumn);
}

export async function getCards(projectId: string): Promise<TaskCard[]> {
  const db = getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM task_cards WHERE project_id = ? AND archived_at IS NULL ORDER BY "order" ASC`,
    [projectId]
  );
  return rows.map(rowToCard);
}

export async function moveCard(cardId: string, columnId: string, now: string): Promise<void> {
  const db = getDb();
  await db.runAsync(
    "UPDATE task_cards SET column_id = ?, updated_at = ?, version = version + 1 WHERE id = ?",
    [columnId, now, cardId]
  );
}

export async function createCard(card: TaskCard): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `INSERT INTO task_cards
     (id, column_id, project_id, workspace_id, title, description, tag_ids, priority,
      due_date, linked_note_ids, blocked_by_ids, "order", assignee, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      card.id,
      card.columnId,
      card.projectId,
      card.workspaceId,
      card.title,
      card.description ?? null,
      JSON.stringify(card.tagIds),
      card.priority,
      card.dueDate ?? null,
      JSON.stringify(card.linkedNoteIds),
      JSON.stringify(card.blockedByIds),
      card.order,
      card.assignee ?? null,
      card.createdAt,
      card.updatedAt,
    ]
  );
}

export async function updateCard(
  cardId: string,
  patch: Partial<Pick<TaskCard, "title" | "description" | "priority" | "dueDate" | "assignee">>,
  now: string
): Promise<void> {
  const db = getDb();
  const sets: string[] = ["updated_at = ?", "version = version + 1"];
  const params: SQLiteBindValue[] = [now];

  if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title); }
  if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
  if (patch.priority !== undefined) { sets.push("priority = ?"); params.push(patch.priority); }
  if (patch.dueDate !== undefined) { sets.push("due_date = ?"); params.push(patch.dueDate); }
  if (patch.assignee !== undefined) { sets.push("assignee = ?"); params.push(patch.assignee); }

  params.push(cardId);
  await db.runAsync(`UPDATE task_cards SET ${sets.join(", ")} WHERE id = ?`, params);
}

export async function getNotes(projectId: string): Promise<Note[]> {
  const db = getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM notes WHERE project_id = ? AND archived_at IS NULL AND type = 'note' ORDER BY is_pinned DESC, updated_at DESC",
    [projectId]
  );
  return rows.map(rowToNote);
}

export async function getNote(id: string): Promise<Note | null> {
  const db = getDb();
  const row = await db.getFirstAsync<Record<string, unknown>>(
    "SELECT * FROM notes WHERE id = ?",
    [id]
  );
  return row ? rowToNote(row) : null;
}

export async function updateNote(
  noteId: string,
  patch: Partial<Pick<Note, "title" | "content" | "contentText">>,
  now: string
): Promise<void> {
  const db = getDb();
  const sets: string[] = ["updated_at = ?", "version = version + 1"];
  const params: SQLiteBindValue[] = [now];

  if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title); }
  if (patch.content !== undefined) { sets.push("content = ?"); params.push(patch.content); }
  if (patch.contentText !== undefined) { sets.push("content_text = ?"); params.push(patch.contentText); }

  params.push(noteId);
  await db.runAsync(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`, params);
}

export async function getTags(workspaceId: string): Promise<Tag[]> {
  const db = getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM tags WHERE workspace_id = ?",
    [workspaceId]
  );
  return rows.map(rowToTag);
}

export async function getThreads(workspaceId: string, projectId?: string): Promise<ChatThread[]> {
  const db = getDb();
  if (projectId) {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      "SELECT * FROM chat_threads WHERE workspace_id = ? AND project_id = ? ORDER BY updated_at DESC",
      [workspaceId, projectId]
    );
    return rows.map(rowToThread);
  }
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM chat_threads WHERE workspace_id = ? ORDER BY updated_at DESC",
    [workspaceId]
  );
  return rows.map(rowToThread);
}

export async function getMessages(threadId: string): Promise<ChatMessage[]> {
  const db = getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC",
    [threadId]
  );
  return rows.map(rowToMessage);
}

export async function createThread(thread: ChatThread): Promise<void> {
  const db = getDb();
  await db.runAsync(
    "INSERT INTO chat_threads (id, scope, workspace_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [thread.id, thread.scope, thread.workspaceId, thread.projectId ?? null, thread.title ?? null, thread.createdAt, thread.updatedAt]
  );
}

export async function createMessage(msg: ChatMessage): Promise<void> {
  const db = getDb();
  await db.runAsync(
    "INSERT INTO chat_messages (id, thread_id, role, content, context_refs, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      msg.id,
      msg.threadId,
      msg.role,
      msg.content,
      msg.contextRefs ? JSON.stringify(msg.contextRefs) : null,
      msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
      msg.createdAt,
    ]
  );
}

export async function updateThreadTimestamp(threadId: string, now: string): Promise<void> {
  const db = getDb();
  await db.runAsync("UPDATE chat_threads SET updated_at = ? WHERE id = ?", [now, threadId]);
}
