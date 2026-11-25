import { describe, expect, it } from "vitest";
import type { BoardColumn, TaskCard } from "@cairn/shared/types/board";
import type { Note } from "@cairn/shared/types/notes";
import type { Project } from "@cairn/shared/types/workspace";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import type { PixelBackend, PixelSurface } from "@cairn/shared/arcade/pixel/painter";
import { buildOffice } from "@cairn/shared/arcade/workspace/build";
import { CONTRACTOR, DEMO_OFFICE, zoneForColumn, type OfficeCard, type OfficeData, type OfficeProject } from "@cairn/shared/arcade/workspace/data";
import { BACK_GAP, DESK_DOWN, DESK_UP, FRONT_STRIP, layoutDesk, layoutFloor, pileHeight, TAG_H, WALL_H, route, routeFree, staff } from "@cairn/shared/arcade/workspace/layout";
import { OfficeRenderer } from "@cairn/shared/arcade/workspace/render";
import { daylightAt, OfficeSim } from "@cairn/shared/arcade/workspace/sim";
import { burstLabel, diffOffice, FLURRY, groupChanges } from "@cairn/shared/arcade/workspace/events";
import { bucketWeek, dayShort, toDateKey, weekDates, withDemoDates } from "@cairn/shared/arcade/workspace/week";
import { PLANTER_BUSH, PLANTER_TALL } from "@cairn/shared/arcade/workspace/models";

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
  dueKey: null,
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
  doneTotal: 0,
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
    expect(o.projects[0].doneTotal).toBe(2);
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

  it("keeps desks off the back wall, the front strip and each other at any size", () => {
    for (const [w, h] of [[480, 295], [225, 295], [360, 240], [800, 600]]) {
      for (const n of [1, 3, 6, 12, 20]) {
        const ps = Array.from({ length: n }, (_, i) => project(`p${i}`, []));
        const first = layoutFloor(ps, w, h, 0);
        for (let pg = 0; pg < first.pageCount; pg++) {
          const f = layoutFloor(ps, w, h, pg);
          const k = f.zoom / 2;
          const boxes = f.desks.map((d) => ({ x0: d.cx - 22 * k, x1: d.cx + 22 * k, y0: d.cy - DESK_UP * k, y1: d.cy + DESK_DOWN * k + TAG_H }));
          boxes.forEach((a, i) => {
            const at = `${n} projects at ${w}x${h}, desk ${i}`;
            expect(a.y0, at).toBeGreaterThanOrEqual(WALL_H + 10 + BACK_GAP - 1);
            expect(a.y1, at).toBeLessThanOrEqual(h - FRONT_STRIP + 1);
            for (const b of boxes.slice(i + 1)) expect(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0, at).toBe(true);
          });
        }
      }
    }
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

  it("walks straight when clear and around a desk when blocked", () => {
    const block = [{ x: 40, y: 30, w: 30, h: 30 }];
    expect(routeFree({ x: 10, y: 10 }, { x: 20, y: 20 }, block, 200, 200)).toEqual([{ x: 20, y: 20 }]);
    const around = routeFree({ x: 10, y: 45 }, { x: 100, y: 45 }, block, 200, 200);
    expect(around.length).toBeGreaterThan(1);
    expect(around[around.length - 1]).toEqual({ x: 100, y: 45 });
    for (const p of around) {
      expect(p.x < 37 || p.x > 73 || p.y < 27 || p.y > 63).toBe(true);
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
    const opened = s.events.at(-1);
    expect(opened?.k).toBe("open");
    if (opened?.k === "open") expect(opened.ref.type).toBe("task");
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

  it("keeps seated people at their desk when other projects shift it", () => {
    const busy = project("busy", [card("a", "doing", "SAM")]);
    const s = make(office([busy]));
    const before = { x: s.workers.get("SAM")!.x, y: s.workers.get("SAM")!.y };
    s.setData(office([busy, ...Array.from({ length: 8 }, (_, i) => project(`other${i}`, []))]));
    const w = s.workers.get("SAM")!;
    const seat = s.floor.desks.find((d) => d.index === w.desk)!.seat;
    expect(seat).not.toEqual(before);
    expect({ x: w.x, y: w.y, mode: w.mode }).toEqual({ ...seat, mode: "sit" });
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

describe("what changed", () => {
  const a = () => project("a", [card("1", "backlog"), card("2", "doing", "SAM"), card("3", "doing", "SAM")], 2);
  const b = () => project("b", [card("4", "review")], 1);
  const base = () => office([a(), b()]);

  it("reports nothing for an identical refresh, the demo office, or a switched workspace", () => {
    expect(diffOffice(base(), base())).toEqual([]);
    expect(diffOffice(DEMO_OFFICE, base())).toEqual([]);
    expect(diffOffice(base(), DEMO_OFFICE)).toEqual([]);
    expect(diffOffice(base(), office([project("z", [card("9", "doing")])]))).toEqual([]);
  });

  it("sees new, moved, edited and finished tasks", () => {
    const next = base();
    next.projects[0].cards = [
      card("1", "backlog", null, { title: "RENAMED" }),
      { ...card("2", "review", "SAM"), columnId: "c-review" },
      card("5", "backlog"),
    ];
    // Card 3 left the open cards and the week's done count rose: it was finished.
    next.projects[0].doneThisWeek = 1;
    const kinds = diffOffice(base(), next).map((c) => `${c.k}:${c.id}`).sort();
    expect(kinds).toEqual(["task.added:5", "task.done:3", "task.moved:2", "task.updated:1"]);
  });

  it("calls a card that left without a done count a deletion", () => {
    const next = base();
    next.projects[0].cards = next.projects[0].cards.slice(0, 2);
    expect(diffOffice(base(), next)).toEqual([{ k: "task.removed", project: "a", id: "3" }]);
  });

  it("reports a card that moved to another project as arriving there, not as news in a new project", () => {
    const next = base();
    next.projects[0].cards = next.projects[0].cards.slice(1);
    next.projects[1].cards = [...next.projects[1].cards, card("1", "backlog")];
    expect(diffOffice(base(), next)).toEqual([{ k: "task.added", project: "b", id: "1" }]);
    // A project that just appeared brings its cards without announcing them.
    expect(diffOffice(base(), office([a(), b(), project("c", [card("7", "doing")])]))).toEqual([]);
  });

  it("tells a note edit from a rename and sees notes come and go", () => {
    const prev = office([a()]);
    prev.projects[0].notes = [{ id: "n1", title: "ONE", pinned: false, rev: "1" }, { id: "n2", title: "TWO", pinned: false, rev: "1" }];
    const next = office([a()]);
    next.projects[0].notes = [{ id: "n1", title: "ONE", pinned: false, rev: "2" }, { id: "n3", title: "THREE", pinned: false, rev: "1" }];
    expect(diffOffice(prev, next).map((c) => `${c.k}:${c.id}`).sort()).toEqual(["note.added:n3", "note.removed:n2", "note.updated:n1"]);
  });

  it("folds a burst into one label per project and kind, with the target column for moves", () => {
    const next = base();
    next.projects[0].cards = Array.from({ length: 6 }, (_, i) => card(`new${i}`, "backlog"));
    next.projects[1].cards = [{ ...card("4", "doing", "RIO"), columnId: "c-doing" }];
    const bursts = groupChanges(diffOffice(base(), next));
    const added = bursts.find((x) => x.kind === "task.added")!;
    expect(added.ids).toHaveLength(6);
    expect(burstLabel(added)).toBe("+ 6 TASKS");
    expect(burstLabel(bursts.find((x) => x.kind === "task.moved")!)).toBe("> DOING");
    expect(burstLabel({ project: "a", kind: "task.done", ids: ["1"], column: null, zone: null })).toBe("DONE!");
  });

  it("starts effects from a refresh: a label and a sheet per burst, capped, and a sample of a flurry", () => {
    const s = make(base());
    const next = base();
    next.projects[0].cards = [...next.projects[0].cards, card("n1", "backlog"), card("n2", "backlog")];
    s.setData(next);
    expect(s.fx.filter((f) => f.k === "label").map((f) => f.text)).toEqual(["+ 2 TASKS"]);
    expect(s.fx.filter((f) => f.k === "paper")).toHaveLength(2);
    expect(s.fresh.has("n1")).toBe(true);
    expect(s.busy).toBe(true);
    for (let i = 0; i < 400; i++) s.step();
    expect(s.fx).toEqual([]);
    expect(s.fresh.size).toBe(0);
    expect(s.busy).toBe(false);

    const big = base();
    big.projects[0].cards = Array.from({ length: FLURRY * 3 }, (_, i) => card(`bulk${i}`, "backlog"));
    s.setData(big);
    expect(s.fx.length).toBeLessThanOrEqual(24);
    expect(s.fresh.size).toBeLessThanOrEqual(FLURRY);
  });

  it("pops the done board when a card is finished", () => {
    const s = make(base());
    const next = base();
    next.projects[0].cards = next.projects[0].cards.slice(0, 2);
    next.projects[0].doneThisWeek = 1;
    s.setData(next);
    expect(s.fx.some((f) => f.k === "paper" && f.to === "board")).toBe(true);
    expect(s.boardPulse).toBeGreaterThan(s.t);
  });

  it("shows a bubble while the AI writes a note, and clears it when it stops", () => {
    const s = make(base());
    s.setNoteWriting("a-n0", true);
    expect(s.projectOfNote("a-n0")?.id).toBe("a");
    expect(s.busy).toBe(true);
    s.setNoteWriting("a-n0", false);
    expect(s.busy).toBe(false);
  });

  it("draws the effects without throwing, on the floor and on an open desk", () => {
    const backend: PixelBackend<unknown, number> = {
      createSurface(width, height): PixelSurface<unknown, number> {
        let w = width, h = height;
        return {
          get W() { return w; },
          get H() { return h; },
          resize(nw, nh) { w = nw; h = nh; },
          clear() {}, snapshot() { return 1; }, toImage() { return null; },
          drawRect() {}, drawStrokeRect() {}, drawCircle() {}, drawLine() {}, drawImage() {}, drawImageRect() {},
          drawTintedImage() {}, drawSprite() {}, drawStack() {}, drawShadow() {}, drawGlyphs() {},
          clipRect(_x, _y, _w, _h, fn) { fn(); },
        };
      },
      makeImage: () => ({}),
      makeAtlas: (model) => ({ model, image: {}, shadow: {} }),
    };
    const s = make(base());
    const r = new OfficeRenderer(backend, s);
    const next = base();
    next.projects[0].cards = [...next.projects[0].cards.slice(1), card("n1", "backlog")];
    next.projects[0].doneThisWeek = 1;
    s.setData(next);
    s.setNoteWriting("a-n0", true);
    for (let i = 0; i < 30; i++) {
      s.step();
      r.draw();
    }
    s.setFocus(0);
    s.setTab("notes");
    r.draw();
    s.setTab("board");
    r.draw();
  });
});

describe("the agent's robot", () => {
  const a = () => project("a", [card("1", "backlog"), card("2", "doing", "SAM")], 1);
  const b = () => project("b", [card("3", "backlog")], 0);

  it("docks idle, walks to the touched desk on intent, and works there", () => {
    const s = make(office([a(), b()]));
    expect(s.robot.mode).toBe("idle");
    expect(s.robot.active).toBe(false);
    s.agentIntent({ type: "task", id: "3" });
    expect(s.robot.desk).toBe(1);
    expect(s.robot.mode).toBe("walk");
    expect(s.robot.active).toBe(true);
    for (let i = 0; i < 3000 && s.robot.mode === "walk"; i++) s.step();
    expect(s.robot.mode).toBe("work");
    const d = s.floor.desks.find((x) => x.index === 1)!;
    expect({ x: s.robot.x, y: s.robot.y }).toEqual({ x: d.side.x, y: d.side.y });
  });

  it("stays put when the intent names nothing in the office", () => {
    const s = make(office([a()]));
    s.agentIntent({ type: "note", id: "missing" });
    expect(s.robot.active).toBe(true);
    expect(s.robot.desk).toBeNull();
  });

  it("opens the agent chat when clicked", () => {
    const s = make(office([a(), b()]));
    s.down(s.sx(s.robot.x), s.sy(s.robot.y) - 4);
    expect(s.events.at(-1)).toEqual({ k: "openAgent" });
  });

  it("attributes a change that follows its intent to the agent", () => {
    const s = make(office([a(), b()]));
    s.agentIntent({ type: "task", id: "n1" });
    const next = office([a(), b()]);
    next.projects[0].cards = [...next.projects[0].cards, card("n1", "backlog")];
    s.setData(next);
    expect(s.fx.some((f) => f.agent)).toBe(true);
    // An unrelated change is nobody's in particular.
    const s2 = make(office([a(), b()]));
    const other = office([a(), b()]);
    other.projects[1].cards = [...other.projects[1].cards, card("zzz", "backlog")];
    s2.setData(other);
    expect(s2.fx.some((f) => f.agent)).toBe(false);
  });

  it("powers down on idle and walks home", () => {
    const s = make(office([a(), b()]));
    s.agentIntent({ type: "task", id: "3" });
    for (let i = 0; i < 3000 && s.robot.mode === "walk"; i++) s.step();
    expect(s.robot.mode).toBe("work");
    s.agentIdle();
    expect(s.robot.active).toBe(false);
    for (let i = 0; i < 6000 && s.robot.mode !== "idle"; i++) s.step();
    expect(s.robot.mode).toBe("idle");
    expect(s.robot.desk).toBeNull();
  });
});

describe("the week wall", () => {
  // Wednesday 2026-11-25.
  const today = () => new Date(2026, 10, 25, 11, 30);
  const dated = (id: string, dueKey: string | null): OfficeCard => ({ ...card(id, "backlog"), dueKey });

  it("pins dated cards on their day and lists the overdue twice", () => {
    const ps = [project("a", [dated("past", "2026-11-20"), dated("today", "2026-11-25"), dated("fri", "2026-11-27"), dated("next", "2026-12-02"), dated("none", null)])];
    const { days, overdue } = bucketWeek(ps, today());
    expect(days).toHaveLength(7);
    expect(days[0].label).toBe("SUN 22");
    expect(days.find((d) => d.key === "2026-11-25")!.isToday).toBe(true);
    expect(days.find((d) => d.key === "2026-11-25")!.cards.map((c) => c.title)).toEqual(["TODAY"]);
    expect(days.find((d) => d.key === "2026-11-27")!.cards.map((c) => c.title)).toEqual(["FRI"]);
    // Next week and unscheduled cards are not on this wall.
    expect(days.flatMap((d) => d.cards.map((c) => c.title))).not.toContain("NEXT");
    expect(days.flatMap((d) => d.cards.map((c) => c.title))).not.toContain("NONE");
    // The past-due card is overdue but its day is off the wall, so only the tray has it.
    expect(overdue.map((c) => c.title)).toEqual(["PAST"]);
    // A past-due card inside the week shows in both.
    const ps2 = [project("a", [dated("mon", "2026-11-23")])];
    const w2 = bucketWeek(ps2, today());
    expect(w2.days.find((d) => d.key === "2026-11-23")!.cards.map((c) => c.title)).toEqual(["MON"]);
    expect(w2.overdue.map((c) => c.title)).toEqual(["MON"]);
  });

  it("dates the demo office around today, so its wall agrees with the done board", () => {
    const projects = withDemoDates(DEMO_OFFICE.projects, NOW);
    const { days, overdue } = bucketWeek(projects, NOW);
    expect(overdue).toHaveLength(DEMO_OFFICE.projects.flatMap((p) => p.cards).filter((c) => c.overdue).length);
    expect(days.some((d) => d.isToday && d.cards.length > 0)).toBe(true);
    const s = make();
    s.setWeek(true);
    expect(s.weekView!.tray.pins.length).toBe(s.boardStats.overdue);
  });

  it("keeps the header clock clear of the week toggle", () => {
    const s = make();
    s.setWeek(true);
    expect(s.calBtn.x + s.calBtn.w).toBeLessThan(s.prevBtn.x);
  });

  it("dims the weekend and keys days in order", () => {
    expect(weekDates(today()).map((d) => toDateKey(d))).toEqual([
      "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28",
    ]);
    const { days } = bucketWeek([], today());
    expect(days.filter((d) => d.isWeekend).map((d) => d.key)).toEqual(["2026-11-22", "2026-11-28"]);
    expect(dayShort("2026-11-27")).toBe("FRI");
    expect(dayShort("nope")).toBe("?");
  });
});

describe("calendar mode", () => {
  const wed = new Date(2026, 10, 25, 11, 30);
  const dated = (id: string, dueKey: string | null): OfficeCard => ({ ...card(id, "backlog"), dueKey });
  const wk = (cards: OfficeCard[]) => {
    const s = new OfficeSim({ width: 480, height: 320, hud: NO_HUD, inputMode: "pointer", office: office([project("a", cards)]), clock: () => wed, seed: 3 });
    return s;
  };

  it("toggles the week wall with the header button and C, and Esc leaves it", () => {
    const s = wk([dated("t1", "2026-11-25")]);
    expect(s.week).toBe(false);
    expect(s.weekView).toBeNull();
    s.down(s.calBtn.x + 2, s.calBtn.y + 2);
    expect(s.week).toBe(true);
    expect(s.weekView?.cols).toHaveLength(7);
    expect(s.setKey("Escape", true)).toBe(true);
    expect(s.week).toBe(false);
    expect(s.setKey("KeyC", true)).toBe(true);
    expect(s.week).toBe(true);
    expect(s.setKey("KeyC", true)).toBe(true);
    expect(s.week).toBe(false);
  });

  it("pins dated cards on their day with an overdue tray, and opens one on click", () => {
    const s = wk([dated("today", "2026-11-25"), dated("old", "2026-11-20")]);
    s.setWeek(true);
    const col = s.weekView!.cols.find((c) => c.key === "2026-11-25")!;
    expect(col.pins.map((p) => p.ref.id)).toEqual(["today"]);
    expect(s.weekView!.tray.pins.map((p) => p.ref.id)).toEqual(["old"]);
    const pin = col.pins[0];
    s.down(pin.x + 2, pin.y + 2);
    expect(s.events.at(-1)).toEqual({ k: "open", ref: { type: "task", id: "today" } });
  });

  it("stays on the floor while the week is open, paging instead of paging desks", () => {
    const s = wk([dated("t1", "2026-11-25")]);
    s.setWeek(true);
    expect(s.hit(s.prevBtn.x + 1, s.prevBtn.y + 1)).toMatchObject({ k: "prev" });
    s.down(s.prevBtn.x + 1, s.prevBtn.y + 1);
    expect(s.weekDays[0].key).toBe("2026-11-15");
    s.setFocus(0);
    expect(s.weekView).toBeNull();
  });

  it("pages the wall week to week with the arrows and C stays put", () => {
    const s = wk([dated("next", "2026-12-02"), dated("past", "2026-11-20")]);
    s.setWeek(true);
    expect(s.weekDays[0].key).toBe("2026-11-22");
    expect(s.weekLabel).toBe("NOV 22-28");
    expect(s.weekView!.tray.pins.map((p) => p.ref.id)).toEqual(["past"]);
    // Next week: the December card pins, the tray still lists the overdue one.
    s.down(s.nextBtn.x + 2, s.nextBtn.y + 2);
    expect(s.weekDays[0].key).toBe("2026-11-29");
    expect(s.weekLabel).toBe("NOV 29-DEC 5");
    expect(s.weekDays.find((d) => d.key === "2026-12-02")!.cards.map((c) => c.ref.id)).toEqual(["next"]);
    expect(s.weekView!.tray.pins.map((p) => p.ref.id)).toEqual(["past"]);
    expect(s.setKey("ArrowLeft", true)).toBe(true);
    expect(s.weekDays[0].key).toBe("2026-11-22");
    // Reopening the wall returns to this week.
    s.setWeek(false);
    s.down(s.nextBtn.x + 2, s.nextBtn.y + 2);
    s.setWeek(true);
    expect(s.weekDays[0].key).toBe("2026-11-22");
  });

  it("draws the week wall without throwing", () => {    const backend: PixelBackend<unknown, number> = {
      createSurface(width, height): PixelSurface<unknown, number> {
        let w = width, h = height;
        return {
          get W() { return w; },
          get H() { return h; },
          resize(nw, nh) { w = nw; h = nh; },
          clear() {}, snapshot() { return 1; }, toImage() { return null; },
          drawRect() {}, drawStrokeRect() {}, drawCircle() {}, drawLine() {}, drawImage() {}, drawImageRect() {},
          drawTintedImage() {}, drawSprite() {}, drawStack() {}, drawShadow() {}, drawGlyphs() {},
          clipRect(_x, _y, _w, _h, fn) { fn(); },
        };
      },
      makeImage: () => ({}),
      makeAtlas: (model) => ({ model, image: {}, shadow: {} }),
    };
    const s = wk([dated("today", "2026-11-25"), dated("old", "2026-11-20")]);
    const r = new OfficeRenderer(backend, s);
    s.setWeek(true);
    for (let i = 0; i < 10; i++) {
      s.step();
      r.draw();
    }
    s.move(s.calBtn.x + 1, s.calBtn.y + 1);
    expect(s.hover?.text).toMatch(/OFFICE/);
  });
});

describe("idle polish", () => {
  const noon = () => new Date(2026, 10, 25, 11, 30);
  const night = () => new Date(2026, 10, 25, 3, 0);
  const dated = (id: string, dueKey: string | null): OfficeCard => ({ ...card(id, "backlog"), dueKey });
  const at = (clock: () => Date, cards: OfficeCard[] = [card("1", "doing", "SAM")]) =>
    new OfficeSim({ width: 480, height: 320, hud: NO_HUD, inputMode: "pointer", office: office([project("a", cards)]), clock, seed: 3 });

  it("sends everyone home at night and brings them back by day", () => {
    let now = night();
    const s = at(() => now);
    expect(s.night).toBe(true);
    expect(s.workers.size).toBe(0);
    expect(s.robot).toBeDefined();
    // Nobody to click at night; the robot still answers.
    expect(s.hit(s.sx(s.robot.x), s.sy(s.robot.y) - 4)).toMatchObject({ k: "robot" });
    now = noon();
    for (let i = 0; i < 61; i++) s.step();
    expect(s.night).toBe(false);
    expect(s.workers.size).toBeGreaterThan(0);
  });

  it("reports done-this-week and overdue counts for the clock whiteboard", () => {
    const ps = [project("a", [card("1", "backlog", null, { overdue: true }), card("2", "doing")])];
    ps[0].doneThisWeek = 4;
    const s = new OfficeSim({ width: 480, height: 320, hud: NO_HUD, inputMode: "pointer", office: office(ps), clock: noon, seed: 3 });
    expect(s.boardStats).toEqual({ done: 4, overdue: 1 });
    expect(at(noon, [dated("none", null)]).boardStats).toEqual({ done: 0, overdue: 0 });
  });

  it("unlocks a plant per finished-ten project and keeps it", () => {
    const ps = [project("a", []), project("b", [])];
    ps[0].doneTotal = 12;
    const s = new OfficeSim({ width: 480, height: 320, hud: NO_HUD, inputMode: "pointer", office: office(ps), clock: noon, seed: 3 });
    expect(s.decor.has("plant:a")).toBe(true);
    expect(s.decor.has("plant:b")).toBe(false);
    expect(s.decorDirty).toBe(true);
    expect(s.floor.plants).toHaveLength(2);
    // The host persists and hands it back; nothing new unlocks after that.
    s.setDecor([...s.decor]);
    expect(s.decorDirty).toBe(false);
    s.setData(office(ps));
    expect(s.decorDirty).toBe(false);
    expect(s.floor.plants).toHaveLength(2);
  });

  it("caps the milestone plants at six extra", () => {
    const ps = Array.from({ length: 10 }, (_, i) => project(`p${i}`, []));
    for (const p of ps) p.doneTotal = 30;
    const s = new OfficeSim({ width: 480, height: 320, hud: NO_HUD, inputMode: "pointer", office: office(ps), clock: noon, seed: 3 });
    expect(s.decor.size).toBe(10);
    expect(s.floor.plants).toHaveLength(7);
  });

  it("builds office planters: a ceramic trough with soil and leaves", () => {
    for (const m of [PLANTER_TALL, PLANTER_BUSH]) {
      // makeModel pads a pixel border around the 9x9 footprint.
      expect([m.w, m.d]).toEqual([11, 11]);
      const alpha = (layer: number, x: number, y: number) => m.layers[layer][((y + 1) * m.w + (x + 1)) * 4 + 3];
      // Ceramic rim around the soil line.
      expect(alpha(3, 0, 4)).not.toBe(0);
      // Soil inside at z=4 and leaves above it.
      expect(alpha(4, 4, 4)).toBe(255);
      const leaves = m.layers.slice(5).some((l) => l.some((v, i) => i % 4 === 3 && v > 0));
      expect(leaves).toBe(true);
    }
    expect(PLANTER_TALL.h).toBeGreaterThan(PLANTER_BUSH.h);
  });
});

describe("the big clock", () => {
  const clockAt = (s: OfficeSim) => ({
    x: s.area.x + s.floor.clock.x,
    y: s.area.y + s.floor.clock.y,
  });

  it("hangs above the bin, clear of the done board and the windows", () => {
    for (const [width, height] of [[480, 295], [225, 295]]) {
      const f = layoutFloor(DEMO_OFFICE.projects, width, height, 0);
      expect(f.clock.x).toBe(f.bin.x);
      expect(f.clock.y).toBeLessThan(f.bin.y);
      expect(f.clock.x + 7).toBeLessThan(f.doneBoard.x);
      for (const w of f.windows) expect(w.x + w.w < f.clock.x - 7 || w.x > f.clock.x + 7).toBe(true);
    }
  });

  it("opens on clock tap and closes on the next tap or Escape", () => {
    const s = make(office([project("a", [card("1", "doing")])]));
    const c = clockAt(s);
    expect(s.hit(c.x, c.y)).toMatchObject({ k: "clock" });
    s.down(c.x, c.y);
    expect(s.clockOpen).toBe(true);
    expect(s.setKey("Escape", true)).toBe(true);
    expect(s.clockOpen).toBe(false);
    s.down(c.x, c.y);
    expect(s.clockOpen).toBe(true);
    s.down(10, 10);
    expect(s.clockOpen).toBe(false);
  });

  it("names the date for the overlay", () => {
    expect(make().dateLine).toBe("WED 25 NOV");
  });

  it("toggles analogue and digital inside the overlay", () => {
    const s = make(office([project("a", [card("1", "doing")])]));
    const c = clockAt(s);
    s.down(c.x, c.y);
    expect(s.clockOpen).toBe(true);
    expect(s.clockDigital).toBe(false);
    const t = s.clockToggleRect()!;
    s.down(t.x + 2, t.y + 2);
    expect(s.clockOpen).toBe(true);
    expect(s.clockDigital).toBe(true);
    expect(s.hit(t.x + 2, t.y + 2)).toMatchObject({ k: "clockMode" });
    s.down(t.x + 2, t.y + 2);
    expect(s.clockDigital).toBe(false);
  });

  it("draws the overlay without throwing", () => {
    const backend: PixelBackend<unknown, number> = {
      createSurface(width, height): PixelSurface<unknown, number> {
        let w = width, h = height;
        return {
          get W() { return w; },
          get H() { return h; },
          resize(nw, nh) { w = nw; h = nh; },
          clear() {}, snapshot() { return 1; }, toImage() { return null; },
          drawRect() {}, drawStrokeRect() {}, drawCircle() {}, drawLine() {}, drawImage() {}, drawImageRect() {},
          drawTintedImage() {}, drawSprite() {}, drawStack() {}, drawShadow() {}, drawGlyphs() {},
          clipRect(_x, _y, _w, _h, fn) { fn(); },
        };
      },
      makeImage: () => ({}),
      makeAtlas: (model) => ({ model, image: {}, shadow: {} }),
    };
    const s = make(office([project("a", [card("1", "doing", "SAM")])]));
    const r = new OfficeRenderer(backend, s);
    s.clockOpen = true;
    for (let i = 0; i < 5; i++) {
      s.step();
      r.draw();
    }
  });
});

describe("paper toss", () => {
  const noon = () => new Date(2026, 10, 25, 11, 30);
  const live = () => office([project("a", [card("1", "doing", "SAM"), card("2", "doing", "SAM")])]);

  it("throws balls that either swish or land, and the books balance", () => {
    const s = new OfficeSim({ width: 480, height: 320, hud: NO_HUD, inputMode: "pointer", office: live(), clock: noon, seed: 3 });
    for (let i = 0; i < 4000; i++) s.step();
    expect(s.tossMade).toBeGreaterThan(0);
    const floor = s.papers.filter((p) => p.state === "floor").length;
    expect(s.tossScored + floor).toBe(s.tossMade);
  });

  it("scores with a swish splash", () => {
    const s = new OfficeSim({ width: 480, height: 320, hud: NO_HUD, inputMode: "pointer", office: live(), clock: noon, seed: 3 });
    s.papers.push({ x: 200, y: 150, sx: 0, sy: 0, tx: 200, ty: 150, t: 0, dur: 1, arcH: 18, state: "fly", scores: true });
    s.step();
    expect(s.papers).toHaveLength(0);
    expect(s.tossScored).toBe(1);
    expect(s.pops).toHaveLength(1);
    for (let i = 0; i < 50; i++) s.step();
    expect(s.pops).toHaveLength(0);
  });

  it("tosses on demand when the bin is tapped", () => {
    const s = new OfficeSim({ width: 480, height: 320, hud: NO_HUD, inputMode: "pointer", office: live(), clock: noon, seed: 3 });
    const F = s.floor;
    expect(s.hit(s.area.x + F.bin.x, s.area.y + F.bin.y)).toMatchObject({ k: "bin" });
    const before = s.tossMade;
    s.down(s.area.x + F.bin.x, s.area.y + F.bin.y);
    expect(s.tossMade).toBe(before + 1);
    expect(s.papers).toHaveLength(1);
  });

  it("the robot steps back and sinks a missed ball", () => {
    const s = new OfficeSim({ width: 480, height: 320, hud: NO_HUD, inputMode: "pointer", office: live(), clock: noon, seed: 3 });
    s.papers.push({ x: 200, y: 150, sx: 200, sy: 150, tx: 200, ty: 150, t: 0, dur: 1, arcH: 18, state: "floor", scores: false });
    const blocks = s.floor.desks.map((d) => d.hit);
    for (let i = 0; i < 12000 && (s.papers.length > 0 || s.robot.mode !== "idle" || s.robot.fetch || s.robot.windup); i++) {
      s.step();
      // The robot walks around desks, never through them.
      for (const b of blocks) {
        expect(s.robot.x < b.x - 2 || s.robot.x > b.x + b.w + 2 || s.robot.y < b.y - 2 || s.robot.y > b.y + b.h + 2).toBe(true);
      }
    }
    expect(s.papers).toHaveLength(0);
    // The forced miss plus any ambient swishes along the way.
    expect(s.tossScored).toBeGreaterThanOrEqual(1);
    expect(s.robot.mode).toBe("idle");
    expect(s.robot.desk).toBeNull();
  });

  it("docks the robot on its charging pad", () => {
    const s = new OfficeSim({ width: 480, height: 320, hud: NO_HUD, inputMode: "pointer", office: live(), clock: noon, seed: 3 });
    expect({ x: s.robot.x, y: s.robot.y }).toEqual(s.dockHome());
    expect(s.dockHome()).toEqual({ x: 24, y: s.floor.h - 22 });
  });

  it("stays put in calm mode", () => {
    const s = new OfficeSim({ width: 480, height: 320, hud: NO_HUD, inputMode: "pointer", office: live(), clock: noon, seed: 3 });
    s.calm = true;
    for (let i = 0; i < 4000; i++) s.step();
    expect(s.tossMade).toBe(0);
  });
});

describe("review fixes", () => {
  const source = (cards: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    buildOffice({
      workspaceName: "日本",
      workspaceId: null,
      projects: [{ id: "p", workspaceId: "w", name: "Ops" }] as unknown as Project[],
      columns: [{ id: "c", projectId: "p", workspaceId: "w", name: "日本", type: "todo", order: 0 }] as unknown as BoardColumn[],
      cards: cards.map((c, i) => ({ id: `t${i}`, projectId: "p", columnId: "c", workspaceId: "w", title: "T", priority: "medium", order: i, ...c })) as unknown as TaskCard[],
      notes: [] as Note[],
      now: NOW,
      ...extra,
    });

  it("puts a date-time due date in the overdue tray as well as the count", () => {
    const o = source([{ dueDate: "2026-11-20T09:30:00" }]);
    expect(o.projects[0].cards[0]).toMatchObject({ overdue: true, dueKey: "2026-11-20" });
    expect(bucketWeek(o.projects, NOW).overdue).toHaveLength(1);
  });

  it("falls back by kind for text the pixel font can't draw", () => {
    const o = source([{ title: "日本", assignee: "日本" }]);
    expect(o.workspace).toBe("WORKSPACE");
    expect(o.projects[0].columns[0].name).toBe("COLUMN");
    expect(o.projects[0].cards[0]).toMatchObject({ title: "UNTITLED", assignee: null });
  });

  it("stops crediting the agent once its window has passed", () => {
    const before = office([project("a", [card("x", "doing")])]);
    const s = make(before);
    s.agentIntent({ type: "task", id: "x" });
    for (let i = 0; i < 400; i++) s.step();
    s.setData(office([project("a", [card("x", "doing", null, { title: "RENAMED BY HAND" })])]));
    expect(s.fx.length).toBeGreaterThan(0);
    expect(s.fx.every((f) => !f.agent)).toBe(true);
  });

  it("returns to the page holding the desk you left, when the last page isn't full", () => {
    const ps = Array.from({ length: 9 }, (_, i) => project(`p${i}`, []));
    const s = make(office(ps), 240, 240);
    const { perPage, pageCount } = s.floor;
    expect(pageCount).toBeGreaterThan(1);
    const last = perPage - 1;
    s.setFocus(last);
    s.setFocus(null);
    expect(s.floor.desks.map((d) => d.index)).toContain(last);
  });
});
