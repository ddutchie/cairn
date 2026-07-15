/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import * as q from "../../db/queries";
import { newId } from "../../db/utils";
import { insertNotification, resolveTagNames } from "../db";

export function create_tag(db: Database.Database, args: Record<string, any>) {
  const { workspaceId, name, color } = args;
  if (!workspaceId || !name) return { error: "workspaceId and name are required" };
  const tag = q.createTag(db, {
    id: newId(),
    workspaceId: workspaceId as string,
    name: name as string,
    color: (color as string) ?? "#6366f1",
  });
  insertNotification(db, "create_tag", "Tag created", `"${tag.name}" tag created`);
  return tag;
}

type TagMode = "add" | "remove" | "set";

function applyTagMode(current: string[], resolved: string[], mode: TagMode): string[] {
  switch (mode) {
    case "remove":
      return current.filter((id) => !resolved.includes(id));
    case "set":
      return Array.from(new Set(resolved));
    case "add":
    default:
      return Array.from(new Set([...current, ...resolved]));
  }
}

/**
 * Resolve tag NAMES to ids WITHOUT creating any that are missing — used for
 * `remove`, where a name that doesn't exist should be a no-op rather than
 * creating (then removing) a tag.
 */
function resolveExistingTagNames(db: Database.Database, workspaceId: string, tagNames: string[]): string[] {
  const ids: string[] = [];
  for (const raw of tagNames) {
    const name = (raw ?? "").trim();
    if (!name) continue;
    const row = db.prepare("SELECT id FROM tags WHERE workspace_id = ? AND LOWER(name) = ?")
      .get(workspaceId, name.toLowerCase()) as { id: string } | undefined;
    if (row) ids.push(row.id);
  }
  return ids;
}

export function tag_note(db: Database.Database, args: Record<string, any>) {
  const { noteId, tagNames, mode = "add" } = args;
  if (!noteId) return { error: "noteId is required" };
  if (!Array.isArray(tagNames) || tagNames.length === 0) {
    return { error: "tagNames must be a non-empty array of tag names" };
  }
  const note = q.getNoteById(db, noteId as string);
  if (!note) return { error: "Note not found" };

  // add/set create missing tags + update in one transaction (roll back tag
  // creation if the update fails); remove never creates.
  const updated = db.transaction(() => {
    const resolved = mode === "remove"
      ? resolveExistingTagNames(db, note.workspaceId as string, tagNames as string[])
      : resolveTagNames(db, note.workspaceId as string, tagNames as string[]);
    const nextTagIds = applyTagMode((note.tagIds as string[]) ?? [], resolved, mode as TagMode);
    return q.updateNote(db, noteId as string, { tagIds: nextTagIds });
  })();

  insertNotification(db, "tag_note", "Note tags updated", `Tags on "${note.title}" were updated`);
  return { id: noteId, title: note.title, tagIds: updated.tagIds, mode };
}

export function tag_task(db: Database.Database, args: Record<string, any>) {
  const { cardId, tagNames, mode = "add" } = args;
  if (!cardId) return { error: "cardId is required" };
  if (!Array.isArray(tagNames) || tagNames.length === 0) {
    return { error: "tagNames must be a non-empty array of tag names" };
  }
  const card = q.getCardById(db, cardId as string);
  if (!card) return { error: "Task not found" };

  const updated = db.transaction(() => {
    const resolved = mode === "remove"
      ? resolveExistingTagNames(db, card.workspaceId as string, tagNames as string[])
      : resolveTagNames(db, card.workspaceId as string, tagNames as string[]);
    const nextTagIds = applyTagMode((card.tagIds as string[]) ?? [], resolved, mode as TagMode);
    return q.updateCard(db, cardId as string, { tagIds: nextTagIds });
  })();

  insertNotification(db, "tag_task", "Task tags updated", `Tags on "${card.title}" were updated`);
  return { id: cardId, title: card.title, tagIds: updated.tagIds, mode };
}
