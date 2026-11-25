import { describe, expect, it } from "vitest";
import { DEMO_ARCADE_PROJECTS, type ArcadeProject } from "@cairn/shared/arcade/pixel/arcade-data";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import type { PixelBackend, PixelSurface } from "@cairn/shared/arcade/pixel/painter";
import { AnglerRenderer } from "@cairn/shared/arcade/angler/render";
import { AnglerSim, SPECIES, TANK_MAX, fishFromProjects, type AnglerSim as Sim } from "@cairn/shared/arcade/angler/sim";
import { fishPixels } from "@cairn/shared/arcade/angler/sprites";
import { fishModel } from "@cairn/shared/arcade/angler/models";

const projects: ArcadeProject[] = DEMO_ARCADE_PROJECTS;
const make = (extra: Partial<ConstructorParameters<typeof AnglerSim>[0]> = {}) =>
  new AnglerSim({ width: 233, height: 320, hud: NO_HUD, inputMode: "touch", projects, demo: false, seed: 4, ...extra });

const tap = (s: Sim, x: number, y: number) => {
  s.down(x, y);
  s.up();
};
/** Somewhere on the water ahead of the dock. */
const water = (s: Sim) => ({ x: s.lake.cx, y: s.lake.cy - s.lake.ry * 0.4 });
const cast = (s: Sim) => {
  const w = water(s);
  tap(s, w.x, w.y);
};
/** Swipe the rod toward heading `a` (a held drag, as a finger would). */
const point = (s: Sim, a: number) => {
  s.up();
  s.down(60, 60);
  s.move(60 + Math.cos(a) * 20, 60 + Math.sin(a) * 20);
};

/** Plays one fish from cast to catch the way a careful player would. */
function land(s: Sim): boolean {
  tap(s, s.goBtn.x + 4, s.goBtn.y + 4);
  cast(s);
  for (let i = 0; i < 6000; i++) {
    s.step();
    if (s.state === "wait" && s.biteWindow > 0) tap(s, 5, 150);
    if (s.state === "lost" || (s.state === "aim" && i > 10)) return false;
    if (s.state === "fight" && s.hooked) {
      const h = s.hooked;
      if (h.tired) s.up();
      else point(s, h.a);
      s.setKey("Space", h.tired);
    }
    if (s.state === "catch") return true;
  }
  return false;
}

describe("angler", () => {
  it("turns tasks and notes into fish: priority picks the species, notes are exotic, overdue fights harder", () => {
    const fish = fishFromProjects(projects);
    const urgent = fish.find((f) => f.kind === "task" && f.priority === "urgent")!;
    const low = fish.find((f) => f.kind === "task" && f.priority === "low")!;
    expect(urgent.species).toBe("pike");
    expect(low.species).toBe("minnow");
    expect(fish.filter((f) => f.kind === "note").every((f) => ["angel", "puffer", "koi"].includes(f.species))).toBe(true);
    const overdue = fish.find((f) => f.overdue)!;
    expect(overdue.pts).toBeGreaterThan(SPECIES[overdue.species].pts);
    // Same workspace, same fish.
    expect(fishFromProjects(projects)).toEqual(fish);
  });

  it("casts, hooks, tires, reels and keeps a fish in the tank", () => {
    const s = make();
    expect(s.state).toBe("tank");
    expect(land(s)).toBe(true);
    const caught = s.caught!;
    for (let i = 0; i < 60; i++) s.step();
    tap(s, s.keepBtn.x + 4, s.keepBtn.y + 4);
    expect(s.state).toBe("tank");
    expect(s.tank.map((f) => f.id)).toEqual([caught.id]);
    expect(s.pool.some((f) => f.id === caught.id)).toBe(false);
    expect(s.tankDirty).toBe(true);
    expect(s.best).toBe(caught.pts);
    expect(s.events).toContain("keep");
  });

  it("snaps the line when you lean against the fish", () => {
    const s = make();
    tap(s, s.goBtn.x + 4, s.goBtn.y + 4);
    cast(s);
    for (let i = 0; i < 6000 && s.state !== "lost"; i++) {
      s.step();
      if (s.state === "wait" && s.biteWindow > 0) tap(s, 5, 150);
      if (s.state === "fight" && s.hooked) point(s, s.hooked.a + Math.PI);
    }
    expect(s.state).toBe("lost");
    expect(s.events).toContain("snap");
  });

  it("forgives an early strike: a nibble only makes it wary, and a strike just before the plunge counts", () => {
    const s = make();
    tap(s, s.goBtn.x + 4, s.goBtn.y + 4);
    cast(s);
    // Wait for the first nibble, then strike too early.
    for (let i = 0; i < 3000 && !s.events.includes("nibble"); i++) s.step();
    const fish = s.biter;
    expect(fish).not.toBeNull();
    const before = s.nibbles;
    tap(s, 5, 150);
    expect(s.events).toContain("early");
    expect(s.biter).toBe(fish);
    expect(s.nibbles).toBe(before + 1);
    expect(s.state).toBe("wait");
    // Keep pressing a beat before each dip: the buffered strike lands the plunge.
    for (let i = 0; i < 3000 && s.state === "wait"; i++) {
      if (s.nibbles === 0 && s.nibbleT % 26 === 20) tap(s, 5, 150);
      s.step();
    }
    expect(s.state).toBe("fight");
  });

  it("strikes with Space as well as a tap", () => {
    const s = make();
    s.setKey("Space", true);
    s.setKey("Space", false);
    expect(s.state).toBe("aim");
    s.setKey("Space", true);
    s.setKey("Space", false);
    expect(s.state).toBe("cast");
    for (let i = 0; i < 3000 && s.biteWindow === 0; i++) s.step();
    s.setKey("Space", true);
    s.setKey("Space", false);
    expect(s.state).toBe("fight");
  });

  it("fishes each project's pond in turn", () => {
    const s = make();
    tap(s, s.goBtn.x + 4, s.goBtn.y + 4);
    const first = s.spotProject.id;
    expect(s.spotPool.every((f) => f.projectId === first)).toBe(true);
    tap(s, s.spotBtn.x + 4, s.spotBtn.y + 4);
    expect(s.spotProject.id).not.toBe(first);
    expect(s.events).toContain("spot");
  });

  it("keeps the tank between visits, and lets fish go when their task is done", () => {
    const s = make();
    land(s);
    for (let i = 0; i < 60; i++) s.step();
    tap(s, s.keepBtn.x + 4, s.keepBtn.y + 4);
    const save = s.snapshot();
    expect(save.fish).toHaveLength(1);

    // Reopened with the same workspace: same tank.
    const again = make({ save });
    expect(again.tank.map((f) => f.id)).toEqual(save.fish.map((f) => f.id));
    expect(again.banner).toBeNull();

    // The task (or note) was finished: the fish swims home.
    const id = save.fish[0].id;
    const done = projects.map((p) => ({ ...p, tasks: p.tasks.filter((t) => t.id !== id), notes: p.notes.filter((n) => n.id !== id) }));
    const liveIds = done.flatMap((p) => [...p.tasks.map((t) => t.id), ...p.notes.map((n) => n.id)]).filter((x): x is string => !!x);
    const later = make({ projects: done, save, liveIds });
    expect(later.tank).toHaveLength(0);
    expect(later.banner?.text).toBe("1 FISH SWAM HOME");
    expect(later.swimmers[0].leaving).toBeGreaterThan(0);
    expect(later.tankDirty).toBe(true);
    for (let i = 0; i < 200; i++) later.step();
    expect(later.swimmers).toHaveLength(0);

    // The demo workspace keeps fish it doesn't know.
    expect(make({ projects: done, save, demo: true }).tank).toHaveLength(1);
  });

  it("lets a fish go from the tank, and caps the tank", () => {
    const fish = fishFromProjects(projects);
    const s = make({ save: { v: 1, fish: fish.slice(0, TANK_MAX + 3) } });
    expect(s.tank).toHaveLength(TANK_MAX);
    expect(s.tankFull).toBe(true);
    const sw = s.swimmers[0];
    tap(s, sw.x, sw.y);
    expect(s.selected).toBe(sw);
    tap(s, s.letGoBtn.x + 4, s.letGoBtn.y + 4);
    expect(s.tank).toHaveLength(TANK_MAX - 1);
    expect(s.pool.some((f) => f.id === sw.spec.id)).toBe(true);
  });

  it("keeps fish from projects that aren't open here (another workspace)", () => {
    const fish = fishFromProjects(projects).slice(0, 2);
    const elsewhere = fish.map((f) => ({ ...f, id: `other-${f.id}`, projectId: "another-workspace-project" }));
    const s = make({ save: { v: 1, fish: elsewhere } });
    expect(s.tank.map((f) => f.id)).toEqual(elsewhere.map((f) => f.id));
    expect(s.banner).toBeNull();
    expect(s.tankDirty).toBe(false);
  });

  it("keeps a fish whose task is still open but past the cap on what the game shows", () => {
    const [f] = fishFromProjects(projects);
    // Same project, but the task isn't in the (capped) game data: only the uncapped live ids know it.
    const capped = { ...f, id: "task-past-the-cap" };
    expect(make({ save: { v: 1, fish: [capped] }, liveIds: ["task-past-the-cap"] }).tank).toHaveLength(1);
    // Without it in the live ids, the task is done and the fish swims home.
    expect(make({ save: { v: 1, fish: [capped] }, liveIds: [] }).tank).toHaveLength(0);
  });

  it("lets no fish go when the live-id lookup failed", () => {
    const [f] = fishFromProjects(projects);
    const capped = { ...f, id: "task-past-the-cap" };
    // No liveIds means the host couldn't read them: unknown is not done, so the fish stays and nothing is saved.
    const s = make({ save: { v: 1, fish: [capped] } });
    expect(s.tank).toHaveLength(1);
    expect(s.banner).toBeNull();
    expect(s.tankDirty).toBe(false);
  });

  it("skips bad saved fish one by one and keeps the good ones", () => {
    const [good] = fishFromProjects(projects);
    const fish = [{ ...good, size: 8.5 }, { ...good, species: "constructor" }, { ...good, size: 999 }, good];
    const s = make({ save: { v: 1, fish } as never });
    expect(s.tank).toHaveLength(1);
    expect(s.tank[0].size).toBe(good.size);
  });

  it("lets a fish go back to the pond as its task is now", () => {
    const fish = fishFromProjects(projects);
    const low = fish.find((f) => f.kind === "task" && f.priority === "low")!;
    // The task was raised to urgent since the catch.
    const raised = projects.map((p) => ({ ...p, tasks: p.tasks.map((t) => (t.id === low.id ? { ...t, priority: "urgent" as const } : t)) }));
    const s = make({ projects: raised, save: { v: 1, fish: [low] } });
    expect(s.tank[0].species).toBe("minnow");
    tap(s, s.swimmers[0].x, s.swimmers[0].y);
    tap(s, s.letGoBtn.x + 4, s.letGoBtn.y + 4);
    expect(s.pool.find((f) => f.id === low.id)?.species).toBe("pike");
  });

  it("holds a strike exactly STRIKE_BUFFER frames before the plunge, and endless early presses can't hold off the bite", () => {
    const s = make();
    tap(s, s.goBtn.x + 4, s.goBtn.y + 4);
    cast(s);
    for (let i = 0; i < 3000 && !s.events.includes("nibble"); i++) s.step();
    expect(s.biter).not.toBeNull();
    // Press on every dip: one extra nibble at most, then the bite comes anyway.
    let bit = false;
    for (let i = 0; i < 600 && !bit; i++) {
      if (s.nibbleT % 26 === 0 && s.nibbles > 0) tap(s, 5, 150);
      s.step();
      bit = s.biteWindow > 0 || s.state === "fight";
    }
    expect(bit).toBe(true);

    // Exactly ten frames early, with the last nibble gone.
    const t = make();
    tap(t, t.goBtn.x + 4, t.goBtn.y + 4);
    cast(t);
    for (let i = 0; i < 4000 && (t.state === "wait" || t.state === "cast"); i++) {
      if (t.biter && t.nibbles === 0 && t.nibbleT % 26 === 16 && t.biteWindow === 0) {
        tap(t, 5, 150);
        break;
      }
      t.step();
    }
    for (let i = 0; i < 12 && t.state !== "fight"; i++) t.step();
    expect(t.state).toBe("fight");
  });

  it("lets go of a held reel key on the catch card, and won't release from a full tank's KEEP", () => {
    const s = make();
    expect(land(s)).toBe(true);
    // Space was held to reel; it's released on the card.
    s.setKey("Space", true);
    s.setKey("Space", false);
    expect((s as unknown as { reelKey: boolean }).reelKey).toBe(false);
    for (let i = 0; i < 60; i++) s.step();

    const fish = fishFromProjects(projects);
    const full = make({ save: { v: 1, fish: fish.slice(0, TANK_MAX) } });
    expect(land(full)).toBe(true);
    expect(full.catchChoice).toBe(1);
    for (let i = 0; i < 60; i++) full.step();
    full.catchChoice = 0;
    full.setKey("Space", true);
    expect(full.state).toBe("catch");
  });

  it("ignores a corrupt save", () => {
    const s = make({ save: { v: 1, fish: [null, { id: 3 }, { id: "x", species: "shark" }] } as never });
    expect(s.tank).toHaveLength(0);
  });

  it("draws every scene, and folds and unfolds", () => {
    let snapshots = 0;
    const noopBackend: PixelBackend<unknown, number> = {
      createSurface(width, height): PixelSurface<unknown, number> {
        let w = width, h = height;
        return {
          get W() { return w; },
          get H() { return h; },
          resize(nw, nh) { w = nw; h = nh; },
          clear() {},
          snapshot() { return ++snapshots; },
          toImage() { return null; },
          drawRect() {},
          drawStrokeRect() {},
          drawCircle() {},
          drawLine() {},
          drawImage() {},
          drawImageRect() {},
          drawTintedImage() {},
          drawSprite() {},
          drawStack() {},
          drawShadow() {},
          drawGlyphs() {},
          clipRect(_x, _y, _w, _h, fn) { fn(); },
        };
      },
      makeImage: () => ({}),
      makeAtlas: (model) => ({ model, image: {}, shadow: {} }),
    };
    const s = make();
    const r = new AnglerRenderer(noopBackend, s);
    const seen = new Set<string>();
    tap(s, s.goBtn.x + 4, s.goBtn.y + 4);
    cast(s);
    for (let i = 0; i < 4000 && s.state !== "catch"; i++) {
      s.step();
      if (s.state === "wait" && s.biteWindow > 0) tap(s, 5, 150);
      if (s.state === "fight" && s.hooked) {
        if (s.hooked.tired) s.up();
        else point(s, s.hooked.a);
        s.setKey("Space", s.hooked.tired);
      }
      if (i % 20 === 0) {
        r.draw();
        seen.add(s.state);
      }
    }
    for (let i = 0; i < 60; i++) s.step();
    r.draw();
    r.resize(320, 320, { ...NO_HUD, top: 6, right: 28 });
    r.draw();
    tap(s, s.keepBtn.x + 4, s.keepBtn.y + 4);
    s.selected = s.swimmers[0];
    expect(r.draw()).toBe(snapshots);
    expect([...seen]).toEqual(expect.arrayContaining(["cast", "wait", "fight"]));
  });

  it("builds a voxel fish for every species", () => {
    for (const f of fishFromProjects(projects)) {
      const m = fishModel(f);
      expect(m.h).toBeGreaterThanOrEqual(3);
      expect(m.w).toBeGreaterThan(f.size);
    }
  });

  it("draws fish sprites with an outline and a mirrored twin", () => {
    const [f] = fishFromProjects(projects);
    const right = fishPixels(f), left = fishPixels(f, true);
    expect(right.w).toBeGreaterThan(f.size);
    const row = Math.floor(right.h / 2);
    const at = (p: typeof right, x: number) => p.pixels[(row * p.w + x) * 4 + 3];
    for (let x = 0; x < right.w; x++) expect(at(left, x)).toBe(at(right, right.w - 1 - x));
  });
});
