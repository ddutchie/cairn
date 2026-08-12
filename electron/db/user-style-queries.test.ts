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
    // The v42 migration is what stages pre-existing rows into sync_pending, so
    // rewind the schema to v41 and let the PRODUCTION migration re-run — no
    // hand-copied SQL. saveUserStyle is written through the (current) v42
    // insert trigger, which also stages; clear that so the only thing left to
    // stage the row is the migration's seed.
    const db = makeDb();
    db.pragma("user_version = 41");
    saveUserStyle(db, { persona: { name: "A" }, fullGuide: "g", cheatsheet: "c", source: "guided" });
    db.prepare("DELETE FROM sync_pending").run();
    applySchema(db); // re-runs v42's production migration (idempotent)
    const pending = db.prepare("SELECT entity, entity_id, op FROM sync_pending WHERE entity = 'user_style'").all();
    expect(pending).toEqual([{ entity: "user_style", entity_id: "global", op: "put" }]);
    db.close();
  });
});
