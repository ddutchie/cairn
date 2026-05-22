/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import { newId } from "../../db/utils";
import { insertNotification } from "../db";

export function create_tag(db: Database.Database, args: Record<string, any>) {
  const { workspaceId, name, color } = args;
  if (!workspaceId || !name) return { error: "workspaceId and name are required" };
  const tagId = newId();
  const tag = { id: tagId, workspaceId: workspaceId as string, name: name as string, color: (color as string) ?? "#6366f1" };
  db.prepare("INSERT INTO tags (id, workspace_id, name, color) VALUES (?, ?, ?, ?)").run(tag.id, tag.workspaceId, tag.name, tag.color);
  insertNotification(db, "create_tag", "Tag created", `"${tag.name}" tag created`);
  return { id: tagId, workspaceId: tag.workspaceId, name: tag.name, color: tag.color };
}
