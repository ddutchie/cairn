/**
 * Task Force easter-egg levels. A pure leaf query (only getDb): each live
 * project with open tasks becomes a level, its open tasks the enemy wave and its
 * notes the pickups. "Open" means not in a done-type board column.
 */

import type { Priority } from "@cairn/shared/types/domain";
import { getDb } from "./index";
import { LIVE } from "./sql";

const MAX_LEVELS = 6;
const MAX_TASKS = 14;
const MAX_NOTES = 4;
const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];

export interface TaskForceLevelRow {
  id: string;
  name: string;
  tasks: { title: string; priority: Priority }[];
  notes: string[];
}

export function listTaskForceLevels(): TaskForceLevelRow[] {
  const db = getDb();
  const projects = db.getAllSync<{ id: string; name: string }>(
    `SELECT p.id, p.name FROM projects p
     WHERE p.deleted_at IS NULL AND p.archived_at IS NULL
       AND EXISTS (
         SELECT 1 FROM task_cards c LEFT JOIN board_columns col ON col.id = c.column_id
         WHERE c.project_id = p.id AND c.deleted_at IS NULL AND c.archived_at IS NULL
           AND COALESCE(col.type, '') <> 'done')
     ORDER BY p.updated_at DESC
     LIMIT ${MAX_LEVELS}`,
  );
  return projects.map((p) => {
    const tasks = db
      .getAllSync<{ title: string; priority: string }>(
        `SELECT c.title, c.priority FROM task_cards c LEFT JOIN board_columns col ON col.id = c.column_id
         WHERE c.project_id = ? AND c.deleted_at IS NULL AND c.archived_at IS NULL
           AND COALESCE(col.type, '') <> 'done'
         ORDER BY CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, c.updated_at DESC
         LIMIT ${MAX_TASKS}`,
        p.id,
      )
      .map((t) => ({
        title: t.title.trim() || "Untitled task",
        priority: (PRIORITIES as string[]).includes(t.priority) ? (t.priority as Priority) : "medium",
      }));
    const notes = db
      .getAllSync<{ title: string }>(
        `SELECT title FROM notes WHERE project_id = ? AND type = 'note' AND ${LIVE} ORDER BY updated_at DESC LIMIT ${MAX_NOTES}`,
        p.id,
      )
      .map((n) => n.title.trim() || "Untitled note");
    return { id: p.id, name: p.name.trim() || "Untitled project", tasks, notes };
  });
}
