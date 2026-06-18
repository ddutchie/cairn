/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import * as q from "../../db/queries";
import { newId } from "../../db/utils";
import { insertNotification } from "../db";

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
