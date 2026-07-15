/**
 * Breakout easter-egg brick sampler. A pure leaf query (only getDb) pulled out
 * of queries.ts; re-exported from there so `@/db/queries` imports are unchanged.
 */

import { getDb } from "./index";

export type BrickKind = "project" | "note" | "card" | "tag";
export interface BrickLabel {
  label: string;
  kind: BrickKind;
}

/**
 * A mixed sample of workspace entities (projects, notes, tasks, tags) to use as
 * bricks in the breakout easter egg. Interleaved by kind so a row of bricks
 * reads as a colourful cross-section of the workspace. Capped at `limit`.
 */
export function listBreakoutBricks(limit = 40): BrickLabel[] {
  const db = getDb();
  const projects = db
    .getAllSync<{ label: string }>(`SELECT name AS label FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 12`)
    .map((r) => ({ label: r.label, kind: "project" as const }));
  const notes = db
    .getAllSync<{ label: string }>(`SELECT title AS label FROM notes WHERE deleted_at IS NULL AND type = 'note' ORDER BY updated_at DESC LIMIT 16`)
    .map((r) => ({ label: r.label, kind: "note" as const }));
  const cards = db
    .getAllSync<{ label: string }>(`SELECT title AS label FROM task_cards WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 16`)
    .map((r) => ({ label: r.label, kind: "card" as const }));
  const tags = db
    .getAllSync<{ label: string }>(`SELECT name AS label FROM tags WHERE deleted_at IS NULL ORDER BY name LIMIT 12`)
    .map((r) => ({ label: r.label, kind: "tag" as const }));

  // Round-robin interleave so bricks alternate kind/colour.
  const buckets = [projects, notes, cards, tags];
  const out: BrickLabel[] = [];
  let added = true;
  while (added && out.length < limit) {
    added = false;
    for (const b of buckets) {
      const next = b.shift();
      if (next) {
        out.push(next);
        added = true;
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}
