/**
 * User writing-style queries — the single-row `user_style` table (persona,
 * full style guide, condensed cheat sheet). App-global: read by the
 * get_user_writing_style tool (chat + agent) and edited via Settings →
 * Writing Style. The row is keyed by a fixed constant and upserted.
 */

import type Database from "better-sqlite3";
import { ts } from "./utils";
import { appendToStyleGuide } from "../../shared/user-style";
import type { UserStylePersona, UserStyleRow, UserStyleSaveInput, UserStyleSource } from "../../shared/types/user-style";
export type { UserStylePersona, UserStyleRow, UserStyleSaveInput, UserStyleSource };

export const USER_STYLE_ID = "global";




interface UserStyleRowRaw {
  id: string;
  persona_json: string | null;
  full_guide: string | null;
  cheatsheet: string | null;
  source: string;
  updated_at: string;
}

function toUserStyle(row: UserStyleRowRaw): UserStyleRow {
  let persona: UserStylePersona | null = null;
  if (row.persona_json) {
    try {
      persona = JSON.parse(row.persona_json) as UserStylePersona;
    } catch {
      persona = null;
    }
  }
  return {
    id: row.id,
    persona,
    fullGuide: row.full_guide ?? "",
    cheatsheet: row.cheatsheet ?? "",
    source: (row.source ?? "none") as UserStyleSource,
    updatedAt: row.updated_at,
  };
}

export function getUserStyle(db: Database.Database): UserStyleRow | null {
  const row = db.prepare("SELECT * FROM user_style WHERE id = ?").get(USER_STYLE_ID) as UserStyleRowRaw | undefined;
  return row ? toUserStyle(row) : null;
}


/** Upsert the single global row. Absent fields preserve the existing value. */
export function saveUserStyle(db: Database.Database, input: UserStyleSaveInput): UserStyleRow {
  const existing = getUserStyle(db);
  const personaJson = input.persona !== undefined ? JSON.stringify(input.persona) : (existing?.persona ? JSON.stringify(existing.persona) : null);
  const fullGuide = input.fullGuide !== undefined ? input.fullGuide : (existing?.fullGuide ?? "");
  const cheatsheet = input.cheatsheet !== undefined ? input.cheatsheet : (existing?.cheatsheet ?? "");
  const now = ts();
  db.prepare(`
    INSERT INTO user_style (id, persona_json, full_guide, cheatsheet, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      persona_json = excluded.persona_json,
      full_guide   = excluded.full_guide,
      cheatsheet   = excluded.cheatsheet,
      source       = excluded.source,
      updated_at   = excluded.updated_at,
      deleted_at   = NULL
  `).run(USER_STYLE_ID, personaJson, fullGuide, cheatsheet, input.source, now);
  return getUserStyle(db)!;
}

export function clearUserStyle(db: Database.Database): void {
  db.prepare("DELETE FROM user_style WHERE id = ?").run(USER_STYLE_ID);
}

export { appendToStyleGuide };

/**
 * Append an observation to the persisted user_style row.
 * Preserves persona and cheatsheet, upserts via saveUserStyle (sync-captured).
 * Returns the saved row, or null when no change was needed (duplicate).
 */
export function appendUserStyleObservation(
  db: Database.Database,
  section: string | undefined,
  content: string,
): { row: UserStyleRow | null; updated: boolean; reason?: string } {
  const trimmed = content.trim();
  if (!trimmed) return { row: getUserStyle(db), updated: false, reason: "Empty content — no change." };
  const existing = getUserStyle(db);
  const existingGuide = existing?.fullGuide ?? "";
  const nextGuide = appendToStyleGuide(existingGuide, section, trimmed);
  if (nextGuide === existingGuide) {
    return { row: existing, updated: false, reason: "Observation already present — no change." };
  }
  const source: UserStyleSource = existing && existing.source !== "none" ? existing.source : "manual";
  const row = saveUserStyle(db, { fullGuide: nextGuide, source });
  return { row, updated: true };
}
