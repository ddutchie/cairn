import { describe, expect, it } from "vitest";
import type { BoardColumn, TaskCard } from "@cairn/shared/types/board";
import type { Note } from "@cairn/shared/types/notes";
import type { Project } from "@cairn/shared/types/workspace";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import type { PixelBackend, PixelSurface } from "@cairn/shared/arcade/pixel/painter";
import { buildOffice } from "@cairn/shared/arcade/workspace/build";
import { CONTRACTOR, DEMO_OFFICE, zoneForColumn, type OfficeCard, type OfficeData, type OfficeProject } from "@cairn/shared/arcade/workspace/data";
import { layoutDesk, layoutFloor, pileHeight, route, staff } from "@cairn/shared/arcade/workspace/layout";
import { OfficeRenderer } from "@cairn/shared/arcade/workspace/render";
import { daylightAt, OfficeSim } from "@cairn/shared/arcade/workspace/sim";

const NOW = new Date(2026, 10, 25, 11, 30);
const clock = () => NOW;
const make = (office: OfficeData = DEMO_OFFICE, width = 480, height = 320) =>
  new OfficeSim({ width, height, hud: NO_HUD, inputMode: "pointer", office, clock, seed: 3 });

const card = (id: string, zone: OfficeCard["zone"], assignee: string | null = null, extra: Partial<OfficeCard> = {}): OfficeCard => ({
  id,
  title: id.toUpperCase(),
  columnId: `c-${zone}`,
  priority: "medium",
  zone,
  assignee,
  overdue: false,
  dueToday: false,
  ...extra,
});

const project = (id: string, cards: OfficeCard[], notes = 0): OfficeProject => ({
  id,
  name: id.toUpperCase(),
  accent: "#2ec4b6",
  columns: (["backlog", "doing", "review", "done"] as const).map((z) => ({ id: `c-${z}`, name: z.toUpperCase(), zone: z })),
  cards,
  notes: Array.from({ length: notes }, (_, i) => ({ id: `${id}-n${i}`, title: `NOTE ${i}`, pinned: i === 0 })),
  doneThisWeek: 0,
});

const office = (projects: OfficeProject[]): OfficeData => ({ workspace: "TEST", projects, demo: false });

describe("building the office from the workspace", () => {
  const base = { workspaceId: "ws", createdAt: "", updatedAt: "" };
  const projects = [
    { ...base, id: "p1", name: "Alpha", color: "", order: 0 },
    { ...base, id: "p2", name: "Beta", color: "", order: 1 },
    { ...base, id: "p3", name: "Archived", color: "", order: 2, archivedAt: "2026-01-01" },
    { ...base, id: "p4", workspaceId: "other", name: "Elsewhere", color: "", order: 3 },
  ] as unknown as Project[];
  const col = (id: string, projectId: string, type: BoardColumn["type"], order: number) => ({ ...base, id, projectId, name: id, type, order }) as BoardColumn;
  const columns = [
    col("todo", "p1", "todo", 0),
    col("custom-before", "p1", "custom", 1),
    col("doing", "p1", "in_progress", 2),
    col("custom-after", "p1", "custom", 3),
    col("done", "p1", "done", 4),
  ];
  const tc = (id: string, columnId: string, extra: Partial<TaskCard> = {}) =>
    ({ ...base, id, projectId: "p1", columnId, title: id, tagIds: [], priority: "medium", linkedNoteIds: [], blockedByIds: [], order: 0, version: 1, ...extra }) as TaskCard;
  const cards = [
    tc("a", "todo", { dueDate: "2026-11-20" }),
    tc("b", "custom-before"),
    tc("c", "doing", { assignee: "  Sam  ", dueDate: "2026-11-25" }),
    tc("d", "custom-after"),
    tc("e", "done", { completedAt: "2026-11-24T10:00:00Z" }),
    tc("f", "done", { completedAt: "2026-10-01T10:00:00Z" }),
    tc("g", "todo", { archivedAt: "2026-11-01" }),
  ];
  const note = (id: string, projectId: string, extra: Partial<Note> = {}) => ({ ...base, id, projectId, title: id, isPinned: false, updatedAt: "2026-11-01", ...extra }) as unknown as Note;
  const notes = [note("n1", "p2"), note("n2", "p2", { deletedAt: "2026-11-02" }), note("n3", "p2", { title: "   " })];
  const o = buildOffice({ workspaceName: "My work", workspaceId: "ws", projects, columns, cards, notes, now: NOW });

  it("keeps the open workspace's live projects, busiest first", () => {
    expect(o.workspace).toBe("MY WORK");
    expect(o.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("puts custom columns with the zone before or after the first in-progress column", () => {
    const zones = Object.fromEntries(o.projects[0].cards.map((c) => [c.id, c.zone]));
    expect(zones).toEqual({ a: "backlog", b: "backlog", c: "doing", d: "review" });
    expect(zoneForColumn("custom")).toBe("backlog");
    expect(zoneForColumn("custom", true)).toBe("review");
  });

  it("counts only this week's done cards, and skips archived ones", () => {
    expect(o.projects[0].doneThisWeek).toBe(1);
    expect(o.projects[0].cards.map((c) => c.id)).not.toContain("g");
  });

  it("marks due state and trims the assignee", () => {
    const by = Object.fromEntries(o.projects[0].cards.map((c) => [c.id, c]));
    expect(by.a.overdue).toBe(true);
    expect(by.c.dueToday).toBe(true);
    expect(by.c.assignee).toBe("SAM");
  });

  it("keeps live, titled notes only", () => {
    expect(o.projects[1].notes.map((n) => n.id)).toEqual(["n1"]);
  });
});

describe("the floor plan", () => {
  it("is deterministic and lays out every desk once across the pages", () => {
    const ps = Array.from({ length: 30 }, (_, i) => project(`p${i}`, [card(`p${i}c`, "doing", `P${i % 7}`)], i % 4));
    const a = layoutFloor(ps, 480, 295, 0);
    expect(layoutFloor(ps, 480, 295, 0)).toEqual(a);
    expect(a.pageCount).toBeGreaterThan(1);
    const seen: number[] = [];
    for (let pg = 0; pg < a.pageCount; pg++) seen.push(...layoutFloor(ps, 480, 295, pg).desks.map((d) => d.index));
    expect(seen).toEqual(ps.map((_, i) => i));
  });

  it("shows a small workspace's desks larger", () => {
    expect(layoutFloor(DEMO_OFFICE.projects, 480, 295, 0).zoom).toBe(3);
    const many = Array.from({ length: 24 }, (_, i) => project(`p${i}`, []));
    expect(layoutFloor(many, 480, 295, 0).zoom).toBe(2);
  });

  it("grows the piles with the counts, capped", () => {
    expect([0, 1, 4, 5, 6, 100].map((n) => pileHeight(n))).toEqual([0, 1, 4, 5, 5, 10]);
  });

  it("seats each person at the desk they're busiest on, with one more standing beside", () => {
    const ps = [
      project("a", [card("1", "doing", "SAM"), card("2", "doing", "RIO"), card("3", "doing", "KIM")]),
      project("b", [card("4", "doing", "SAM"), card("5", "doing", "SAM")]),
      project("c", [card("6", "doing", null), card("7", "backlog", "ADA")]),
    ];
    const s = staff(ps);
    expect(s[1]).toEqual({ holder: "SAM", visitor: null });
    expect(s[0].holder).toBe("KIM");
    expect(s[0].visitor).toBe("RIO");
    // Unassigned work in progress brings the contractor; a backlog assignee doesn't sit.
    expect(s[2]).toEqual({ holder: CONTRACTOR, visitor: null });
  });

  it("routes along the walkways, ending where it was sent", () => {
    const path = route({ x: 10, y: 10 }, { x: 80, y: 60 }, { aisleY: 30, laneX: 2 }, { aisleY: 70, laneX: 50 });
    expect(path[path.length - 1]).toEqual({ x: 80, y: 60 });
    // Every leg is straight: no diagonal cuts across desks.
    let prev = { x: 10, y: 10 };
    for (const p of path) {
      expect(p.x === prev.x || p.y === prev.y).toBe(true);
      prev = p;
    }
  });
});

describe("an opened desk", () => {
  const p = project("p", [card("t1", "backlog"), card("t2", "doing", "SAM"), ...Array.from({ length: 40 }, (_, i) => card(`x${i}`, "review"))], 70);
  const v = layoutDesk({ ...p, doneThisWeek: 4 }, { x: 0, y: 0, w: 460, h: 270 }, 0);

  it("lays out the board's columns, with the done count instead of cards", () => {
    expect(v.columns.map((c) => c.name)).toEqual(["BACKLOG", "DOING", "REVIEW", "DONE"]);
    expect(v.columns[3]).toMatchObject({ done: true, count: 4, stickies: [] });
    expect(v.columns[0].stickies.map((s) => s.card.id)).toEqual(["t1"]);
  });

  it("shows what fits and counts the rest", () => {
    const r = v.columns[2];
    expect(r.stickies.length + r.more).toBe(40);
    expect(r.more).toBeGreaterThan(0);
    for (const s of r.stickies) expect(s.y + s.h).toBeLessThanOrEqual(270);
  });

  it("pages the notes", () => {
    expect(v.notesPages).toBeGreaterThan(1);
    const all = new Set<string>();
    for (let i = 0; i < v.notesPages; i++) for (const n of layoutDesk(p, v.area, i).notes) all.add(n.ref.id);
    expect(all.size).toBe(70);
  });

  it("hides columns that can't fit a narrow screen, and says so", () => {
    const many = { ...p, columns: Array.from({ length: 9 }, (_, i) => ({ id: `k${i}`, name: `K${i}`, zone: "backlog" as const })) };
    const n = layoutDesk(many, { x: 0, y: 0, w: 200, h: 270 }, 0);
    expect(n.columns.length + n.hiddenColumns).toBe(9);
    expect(n.hiddenColumns).toBeGreaterThan(0);
  });
});

describe("the office", () => {
  it("opens a desk on click, a card on the board, and goes back with Escape", () => {
    const s = make();
    const d = s.floor.desks[0];
    s.down(s.sx(d.cx), s.sy(d.cy - 14));
    expect(s.state).toBe("desk");
    expect(s.focused?.id).toBe(d.project.id);
    const sticky = s.view!.columns.flatMap((c) => c.stickies)[0];
    s.down(sticky.x + 2, sticky.y + 2);
    expect(s.events).toEqual([{ k: "open", ref: { type: "task", id: sticky.card.id } }]);
    expect(s.setKey("Escape", true)).toBe(true);
    expect(s.state).toBe("floor");
    // On the floor, Escape is the host's (back to the arcade menu).
    expect(s.setKey("Escape", true)).toBe(false);
  });

  it("opens a note from the notes tab", () => {
    const s = make();
    s.setFocus(0);
    s.setKey("KeyN", true);
    expect(s.tab).toBe("notes");
    const n = s.view!.notes[0];
    s.down(n.x + 3, n.y + 3);
    expect(s.events.at(-1)).toEqual({ k: "open", ref: { type: "note", id: n.ref.id } });
  });

  it("shows a person's cards in progress when clicked, and opens one", () => {
    const s = make();
    const w = s.workers.get("SAM")!;
    const k = s.floor.zoom / 2;
    s.down(s.sx(w.x), s.sy(w.y - 4 * k));
    expect(s.bubble?.worker.holder).toBe("SAM");
    const line = s.bubble!.lines[0];
    s.down(line.rect.x + 2, line.rect.y + 2);
    expect(s.events.at(-1)?.ref.type).toBe("task");
    expect(s.bubble).toBeNull();
  });

  it("keeps workers where they are across a data refresh, and walks them to a new desk", () => {
    const ps = [project("a", [card("1", "doing", "SAM")]), project("b", [card("2", "doing", "RIO")])];
    const s = make(office(ps));
    const sam = s.workers.get("SAM")!;
    for (let i = 0; i < 30; i++) s.step();
    const at = { x: sam.x, y: sam.y };
    // Sam's card moves to project b, where Sam now has more work than Rio.
    s.setData(office([project("a", []), project("b", [card("2", "doing", "RIO"), card("1", "doing", "SAM"), card("3", "doing", "SAM")])]));
    const again = s.workers.get("SAM")!;
    expect(again).toBe(sam);
    expect({ x: again.x, y: again.y }).toEqual(at);
    expect(again.mode).toBe("walk");
    for (let i = 0; i < 3000 && again.mode === "walk"; i++) s.step();
    const desk = s.floor.desks.find((d) => d.index === again.desk)!;
    expect(desk.project.id).toBe("b");
    const home = again.spot === "seat" ? desk.seat : desk.side;
    expect({ x: again.x, y: again.y }).toEqual(home);
  });

  it("stays on the open desk when the data changes, and leaves it when the project goes", () => {
    const ps = [project("a", [card("1", "doing")]), project("b", [card("2", "backlog")])];
    const s = make(office(ps));
    s.setFocus(1);
    s.setData(office([ps[1], ps[0]]));
    expect(s.focused?.id).toBe("b");
    s.setData(office([ps[0]]));
    expect(s.state).toBe("floor");
  });

  it("falls back to the demo office for an empty workspace", () => {
    const s = make(office([]));
    expect(s.data.demo).toBe(true);
    expect(s.hint).toContain("DEMO");
  });

  it("follows the clock: night, dawn, day, dusk", () => {
    const at = (h: number, m = 0) => daylightAt(new Date(2026, 0, 1, h, m));
    expect(at(3)).toBe(0);
    expect(at(7)).toBe(0.5);
    expect(at(12)).toBe(1);
    expect(at(18, 30)).toBe(0.5);
    expect(make().clockText).toBe("11:30");
  });

  it("draws the floor and an open desk, and survives the Duo's fold", () => {
    let frames = 0;
    let stacks = 0;
    const backend: PixelBackend<unknown, number> = {
      createSurface(width, height): PixelSurface<unknown, number> {
        let w = width, h = height;
        return {
          get W() { return w; },
          get H() { return h; },
          resize(nw, nh) { w = nw; h = nh; },
          clear() {},
          snapshot() { return ++frames; },
          toImage() { return null; },
          drawRect() {},
          drawStrokeRect() {},
          drawCircle() {},
          drawLine() {},
          drawImage() {},
          drawImageRect() {},
          drawTintedImage() {},
          drawSprite() {},
          drawStack() { stacks++; },
          drawShadow() {},
          drawGlyphs() {},
          clipRect(_x, _y, _w, _h, fn) { fn(); },
        };
      },
      makeImage: () => ({}),
      makeAtlas: (model) => ({ model, image: {}, shadow: {} }),
    };
    const s = make();
    const r = new OfficeRenderer(backend, s);
    for (let i = 0; i < 200; i++) s.step();
    r.draw();
    expect(stacks).toBeGreaterThan(5);
    s.setFocus(0);
    r.draw();
    s.setTab("notes");
    r.resize(233, 320);
    r.draw();
    s.setFocus(null);
    r.resize(320, 320);
    r.draw();
    expect(frames).toBe(4);
  });
});
