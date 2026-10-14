import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { applySchema } from "./schema";
import { createWorkspace, createProject, createNote, deleteNote, getNoteById } from "./queries";
import { convertLegacyDashboards, dashboardToMarkdown } from "./legacy-dashboards";

function makeDb() {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws", name: "WS" });
  createProject(db, { id: "p", workspaceId: "ws", name: "P" });
  return db;
}

/** Dashboards can no longer be created through the API, so seed the legacy type directly. */
function seedDashboard(db: BetterSqlite3.Database, id: string, html: string) {
  createNote(db, { id, projectId: "p", workspaceId: "ws", title: `Dash ${id}`, content: html });
  db.prepare("UPDATE notes SET type = 'dashboard' WHERE id = ?").run(id);
}

describe("dashboardToMarkdown", () => {
  it("keeps the HTML in an html fence after an explanation", () => {
    const md = dashboardToMarkdown("<div>hi</div>");
    expect(md).toContain("This was a Cairn dashboard");
    expect(md).toContain("```html\n<div>hi</div>\n```");
  });

  it("uses a fence longer than any backtick run in the HTML", () => {
    const md = dashboardToMarkdown("<pre>````code````</pre>");
    expect(md).toContain("`````html\n<pre>````code````</pre>\n`````");
  });

  it("omits the code block for an empty dashboard", () => {
    expect(dashboardToMarkdown("  ")).not.toContain("```");
  });
});

describe("convertLegacyDashboards", () => {
  it("rewrites live dashboards as markdown notes and leaves others alone", () => {
    const db = makeDb();
    seedDashboard(db, "d1", "<h1>Board</h1>");
    createNote(db, { id: "n1", projectId: "p", workspaceId: "ws", title: "Plain", content: "body" });

    const converted = convertLegacyDashboards(db);

    expect(converted.map((n) => n.id)).toEqual(["d1"]);
    const d1 = getNoteById(db, "d1")!;
    expect(d1.type).toBe("note");
    expect(d1.content).toContain("```html\n<h1>Board</h1>\n```");
    expect(getNoteById(db, "n1")!.content).toBe("body");
  });

  it("skips tombstoned dashboards and is a no-op once converted", () => {
    const db = makeDb();
    seedDashboard(db, "gone", "<p>x</p>");
    deleteNote(db, "gone");
    seedDashboard(db, "d2", "<p>y</p>");

    expect(convertLegacyDashboards(db).map((n) => n.id)).toEqual(["d2"]);
    const raw = db.prepare("SELECT type, content FROM notes WHERE id = 'gone'").get() as { type: string; content: string };
    expect(raw).toEqual({ type: "dashboard", content: "<p>x</p>" });
    expect(convertLegacyDashboards(db)).toEqual([]);
  });
});
