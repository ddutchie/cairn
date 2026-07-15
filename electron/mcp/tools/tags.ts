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

export function tag_note(db: Database.Database, args: Record<string, any>) {
  const { noteId, tagNames, mode = "add" } = args;
  if (!noteId) return { error: "noteId is required" };
  if (!Array.isArray(tagNames) || tagNames.length === 0) {
    return { error: "tagNames must be a non-empty array of tag names" };
  }
  const note = q.getNoteById(db, noteId as string);
  if (!note) return { error: "Note not found" };

  const resolved = resolveTagNames(db, note.workspaceId as string, tagNames as string[]);
  const current = (note.tagIds as string[]) ?? [];
  const nextTagIds = applyTagMode(current, resolved, mode as TagMode);

  const updated = q.updateNote(db, noteId as string, { tagIds: nextTagIds });
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

  const resolved = resolveTagNames(db, card.workspaceId as string, tagNames as string[]);
  const current = (card.tagIds as string[]) ?? [];
  const nextTagIds = applyTagMode(current, resolved, mode as TagMode);

  const updated = q.updateCard(db, cardId as string, { tagIds: nextTagIds });
  insertNotification(db, "tag_task", "Task tags updated", `Tags on "${card.title}" were updated`);
  return { id: cardId, title: card.title, tagIds: updated.tagIds, mode };
}
