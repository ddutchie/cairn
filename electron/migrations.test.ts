import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { checkMigrations, runAllPendingMigrations } from "./migrations";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-migration-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cairn Migration System", () => {
  it("does not require migration if notes/ folder does not exist", () => {
    const statuses = checkMigrations(tmpDir);
    const m = statuses.find((s) => s.id === "v1.5-drop-notes-dir");
    expect(m).toBeDefined();
    expect(m!.needed).toBe(false);
  });

  it("requires migration if notes/ folder contains project directories but no direct .md files", () => {
    const notesDir = path.join(tmpDir, "notes");
    fs.mkdirSync(path.join(notesDir, "proj-a"), { recursive: true });
    fs.writeFileSync(path.join(notesDir, "proj-a", "note1.md"), "# Note 1", "utf-8");

    const statuses = checkMigrations(tmpDir);
    const m = statuses.find((s) => s.id === "v1.5-drop-notes-dir");
    expect(m!.needed).toBe(true);
  });

  it("bypasses migration if notes/ folder contains direct .md files (Obsidian style)", () => {
    const notesDir = path.join(tmpDir, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, "direct-note.md"), "# Direct Note", "utf-8");
    // Even if there's a subdirectory
    fs.mkdirSync(path.join(notesDir, "proj-a"), { recursive: true });
    fs.writeFileSync(path.join(notesDir, "proj-a", "note1.md"), "# Note 1", "utf-8");

    const statuses = checkMigrations(tmpDir);
    const m = statuses.find((s) => s.id === "v1.5-drop-notes-dir");
    expect(m!.needed).toBe(false);
  });

  it("performs migration copy-verify-delete successfully", async () => {
    const notesDir = path.join(tmpDir, "notes");
    fs.mkdirSync(path.join(notesDir, "proj-a"), { recursive: true });
    fs.writeFileSync(path.join(notesDir, "proj-a", "note1.md"), "# Note 1 Content", "utf-8");

    const statusesBefore = checkMigrations(tmpDir);
    expect(statusesBefore.find((s) => s.id === "v1.5-drop-notes-dir")!.needed).toBe(true);

    const migratedCount = await runAllPendingMigrations(tmpDir, () => {});
    expect(migratedCount).toBe(1);

    // Verify notes have moved to root
    const rootProjDir = path.join(tmpDir, "proj-a");
    expect(fs.existsSync(rootProjDir)).toBe(true);
    expect(fs.readFileSync(path.join(rootProjDir, "note1.md"), "utf-8")).toBe("# Note 1 Content");

    // Original notes directory is deleted/gone
    expect(fs.existsSync(notesDir)).toBe(false);

    // Migration marked complete
    const statusesAfter = checkMigrations(tmpDir);
    expect(statusesAfter.find((s) => s.id === "v1.5-drop-notes-dir")!.needed).toBe(false);
  });
});
