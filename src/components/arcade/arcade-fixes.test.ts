import { describe, expect, it } from "vitest";
import type { BoardColumn, TaskCard } from "@cairn/shared/types/board";
import type { Note } from "@cairn/shared/types/notes";
import type { Project, Tag } from "@cairn/shared/types/workspace";
import { buildArcadeData, interleave } from "./data";
import { BW, fitBricksToWidth, type Brick } from "./games/breakout";
import { fontSafe } from "./pixel/kit";

const TS = "2026-11-24T10:00:00.000Z";

function makeProject(id: string, name: string): Project {
  return {
    id, workspaceId: "ws", name, description: "", status: "active", priority: "medium",
    tagIds: [], codeDirectory: null, createdAt: TS, updatedAt: TS,
  };
}
function makeCol(id: string, projectId: string): BoardColumn {
  return { id, projectId, workspaceId: "ws", name: "Todo", type: "todo", order: 0, createdAt: TS, updatedAt: TS };
}
function makeCard(id: string, projectId: string, title: string, dueDate?: string): TaskCard {
  return {
    id, columnId: `${projectId}-col`, projectId, workspaceId: "ws", title, description: "",
    tagIds: [], priority: "medium", dueDate, linkedNoteIds: [], blockedByIds: [], version: 0, order: 0, createdAt: TS, updatedAt: TS,
  };
}
function makeNote(id: string, projectId: string, title: string, opts: { pinned?: boolean; links?: string[]; updatedAt?: string } = {}): Note {
  return {
    id, projectId, workspaceId: "ws", title, content: "", contentText: "body", tagIds: [],
    linkedNoteIds: opts.links ?? [], linkedCardIds: [], isPinned: opts.pinned ?? false,
    type: "note", folder: "", version: 0, createdAt: TS, updatedAt: opts.updatedAt ?? TS,
  };
}

describe("arcade PR review fixes", () => {
  it("builds noteIds from the ranked & capped notes, excluding dropped notes", () => {
    // 9 notes in p1: n9 is pinned so it beats n1..n8 after sorting, while n8 is dropped.
    const notes: Note[] = Array.from({ length: 8 }, (_, i) =>
      makeNote(`n${i + 1}`, "p1", `Note ${i + 1}`, { updatedAt: `2026-11-24T10:0${8 - i}:00.000Z` }),
    );
    // n1 links to both n8 (dropped) and n9 (pinned, kept).
    notes[0] = makeNote("n1", "p1", "Note 1", { pinned: true, links: ["n8", "n9"] });
    notes.push(makeNote("n9", "p1", "Pinned 9", { pinned: true }));
    // Add p2 so enough() threshold (2 projects, >=6 tasks, >=12 labels) is satisfied.
    notes.push(makeNote("n10", "p2", "Other Note"));

    const data = buildArcadeData({
      projects: [makeProject("p1", "Alpha"), makeProject("p2", "Beta")],
      columns: [makeCol("p1-col", "p1"), makeCol("p2-col", "p2")],
      cards: [
        makeCard("c1", "p1", "Task 1", "2026-11-24"),
        makeCard("c2", "p1", "Task 2", "2026-11-24"),
        makeCard("c3", "p1", "Task 3", "2026-11-24"),
        makeCard("c4", "p2", "Task 4", "2026-11-24"),
        makeCard("c5", "p2", "Task 5", "2026-11-24"),
        makeCard("c6", "p2", "Task 6", "2026-11-25"),
      ],
      tags: Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, workspaceId: "ws", name: `Tag${i}`, color: "#fff" } as Tag)),
      notes,
      workspaceId: "ws",
      now: new Date("2026-11-24T12:00:00"),
    });

    expect(data.demo).toBe(false);
    const p1 = data.projects.find((p) => p.id === "p1")!;
    const n1 = p1.notes.find((n) => n.id === "n1")!;
    expect(n1.links).toEqual(["n9"]);
    const p2 = data.projects.find((p) => p.id === "p2")!;
    expect(p2.tasks[2].dueScope).toBe("later");
  });

  it("caps interleave at 64 labels", () => {
    const projects = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      accent: "#fff",
      biome: "tropic" as const,
      tasks: Array.from({ length: 12 }, (__, j) => ({ title: `T${i}-${j}`, priority: "low" as const, dueMin: 100, overdue: false, column: "todo" as const })),
      notes: Array.from({ length: 8 }, (__, j) => ({ id: `n${i}-${j}`, title: `N${i}-${j}`, words: 100, links: [] })),
    }));
    const labels = interleave({ projects, tags: Array.from({ length: 12 }, (_, i) => `TAG${i}`) });
    expect(labels).toHaveLength(64);
  });

  it("preserves word boundaries in fontSafe across tabs and newlines", () => {
    expect(fontSafe("fix\nsync\tbug")).toBe("FIX SYNC BUG");
    expect(fontSafe("  hello™\nworld! ")).toBe("HELLO WORLD!");
  });

  it("keeps all surviving breakout bricks inside the playfield after shrinking from 960 to 180", () => {
    // 16 columns × 7 rows = 112 bricks at W = 960, with 12 destroyed (100 remaining).
    const cols = 16, bx0 = (960 - (cols - 1) * 28) / 2;
    const bricks: Brick[] = [];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === 0 && c < 12) continue;
        bricks.push({ x: bx0 + c * 28, y: 62 + r * 12, kind: "card", label: `B${r}-${c}`, ph: 0 });
      }
    }
    expect(bricks).toHaveLength(100);
    fitBricksToWidth(bricks, (180 - 960) / 2, 180);
    expect(bricks).toHaveLength(100);
    for (const b of bricks) {
      expect(b.x).toBeGreaterThanOrEqual(BW / 2 + 2);
      expect(b.x).toBeLessThanOrEqual(180 - BW / 2 - 2);
    }
  });
});
