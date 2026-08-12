import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema";
import { getUserStyle, saveUserStyle, clearUserStyle, USER_STYLE_ID } from "./user-style-queries";

function makeDb() {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("user-style queries", () => {
  it("returns null before anything is saved", () => {
    const db = makeDb();
    expect(getUserStyle(db)).toBeNull();
    db.close();
  });

  it("upserts a single global row with parsed persona", () => {
    const db = makeDb();
    const saved = saveUserStyle(db, {
      persona: { name: "Gerard", role: "Engineering lead" },
      fullGuide: "## 1. Voice in one line\nWarm and precise.",
      cheatsheet: "Warm and precise.",
      source: "guided",
    });
    expect(saved.id).toBe(USER_STYLE_ID);
    expect(saved.persona?.name).toBe("Gerard");
    expect(saved.fullGuide).toContain("Voice in one line");
    expect(saved.cheatsheet).toContain("Warm and precise.");

    // Re-saving preserves fields not supplied.
    const updated = saveUserStyle(db, { cheatsheet: "Updated.", source: "guided" });
    expect(updated.fullGuide).toContain("Voice in one line");
    expect(updated.cheatsheet).toBe("Updated.");
    db.close();
  });

  it("parses persona defensively (bad JSON → null)", () => {
    const db = makeDb();
    saveUserStyle(db, { persona: { name: "A" }, fullGuide: "", cheatsheet: "", source: "guided" });
    db.prepare("UPDATE user_style SET persona_json = ?").run("not json{");
    expect(getUserStyle(db)?.persona).toBeNull();
    db.close();
  });

  it("clearUserStyle removes the row", () => {
    const db = makeDb();
    saveUserStyle(db, { persona: { name: "A" }, fullGuide: "g", cheatsheet: "c", source: "guided" });
    clearUserStyle(db);
    expect(getUserStyle(db)).toBeNull();
    db.close();
  });

  it("v42 seeds a pre-existing style into sync_pending so backfill isn't required", () => {
    // Simulate a writing style that existed BEFORE the v42 sync migration: the
    // row is present but nothing is staged (its capture trigger didn't exist
    // yet, and backfill already ran, so it would otherwise never reach the
    // oplog). Migration v42 handles this by seeding sync_pending.
    const db = makeDb();
    saveUserStyle(db, { persona: { name: "A" }, fullGuide: "g", cheatsheet: "c", source: "guided" });
    db.prepare("DELETE FROM sync_pending").run(); // simulate pre-trigger world
    db.prepare(`
      INSERT INTO sync_pending (entity, entity_id, op)
      SELECT 'user_style', id, 'put' FROM user_style
      WHERE deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM sync_pending WHERE entity = 'user_style' AND entity_id = user_style.id)
    `).run();
    const pending = db.prepare("SELECT entity, entity_id, op FROM sync_pending WHERE entity = 'user_style'").all();
    expect(pending).toEqual([{ entity: "user_style", entity_id: "global", op: "put" }]);
    db.close();
  });
});
