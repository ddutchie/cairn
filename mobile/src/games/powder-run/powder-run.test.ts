import { describe, expect, it } from "vitest";
import { DEMO_ARCADE_PROJECTS } from "@cairn/shared/arcade/pixel/arcade-data";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import type { PixelBackend, PixelSurface } from "@cairn/shared/arcade/pixel/painter";
import { PowderRunRenderer } from "@cairn/shared/arcade/powder-run/render";
import { PowderRunSim, RUN_LEN, gradeRun, pipeHeightAt } from "@cairn/shared/arcade/powder-run/sim";

describe("PowderRunSim", () => {
  it("starts a project run and launches into air tricks", () => {
    const sim = new PowderRunSim({ width: 220, height: 320, hud: NO_HUD, inputMode: "pointer", projects: DEMO_ARCADE_PROJECTS });
    expect(sim.state).toBe("title");
    sim.down(110, 160);
    expect(sim.state).toBe("intro");
    for (let i = 0; i < 90; i++) sim.step();
    expect(sim.state).toBe("ride");

    const y0 = sim.rider.y;
    for (let i = 0; i < 20; i++) sim.step();
    expect(sim.rider.y).toBeGreaterThan(y0);

    // Pop an ollie, then hold a grab until it finishes
    expect(sim.triggerAirTrick()).toBe(true);
    expect(sim.rider.air).toBe(true);
    sim.rider.vz = 3;
    expect(sim.triggerAirTrick("grab")).toBe(true);
    expect(sim.triggerAirTrick("flip")).toBe(false); // one trick at a time
    const before = sim.score;
    for (let i = 0; i < 200 && sim.rider.air; i++) sim.step();
    expect(sim.rider.air).toBe(false);
    expect(sim.chain).toBe(1);
    expect(sim.score).toBeGreaterThan(before);
    expect(sim.events).toContain("land");
  });

  it("bails a trick landed mid-rotation and ends the run after three", () => {
    const sim = new PowderRunSim({ width: 220, height: 320, hud: NO_HUD, inputMode: "pointer", projects: DEMO_ARCADE_PROJECTS });
    sim.down(110, 160);
    for (let i = 0; i < 90; i++) sim.step();
    sim.items = [];
    for (let n = 0; n < 3; n++) {
      sim.rider.inv = 0;
      sim.triggerAirTrick(); // ollie: too short for a backflip
      sim.triggerAirTrick("flip");
      for (let i = 0; i < 60 && sim.rider.air; i++) sim.step();
      expect(sim.hearts).toBe(2 - n);
    }
    expect(sim.state).toBe("over");
    expect(sim.events).toContain("bail");
    // Retry rides the same project with full hearts.
    for (let i = 0; i < 60; i++) sim.step();
    sim.down(110, 160);
    expect(sim.state).toBe("intro");
    expect(sim.hearts).toBe(3);
  });

  it("counts air gems toward the grade only once a clean landing banks them", () => {
    const sim = new PowderRunSim({ width: 220, height: 320, hud: NO_HUD, inputMode: "pointer", projects: DEMO_ARCADE_PROJECTS });
    sim.down(110, 160);
    for (let i = 0; i < 90; i++) sim.step();
    sim.items = [];
    const before = sim.collected;
    // Bailed: the held gem is lost, from the score and the grade.
    sim.triggerAirTrick();
    sim.triggerAirTrick("flip");
    sim.heldGems = 100;
    sim.heldCount = 1;
    for (let i = 0; i < 60 && sim.rider.air; i++) sim.step();
    expect(sim.collected).toBe(before);
    // Landed clean: it counts.
    sim.rider.inv = 0;
    sim.triggerAirTrick();
    sim.heldGems = 100;
    sim.heldCount = 1;
    for (let i = 0; i < 60 && sim.rider.air; i++) sim.step();
    expect(sim.collected).toBe(before + 1);
  });

  it("grades a run from collection, time and bails", () => {
    expect(gradeRun(10, 10, 0)).toBe("S");
    expect(gradeRun(8, 10, 1)).toBe("A");
    expect(gradeRun(5, 10, 2)).toBe("B");
    expect(gradeRun(1, 10, 0)).toBe("C");
  });

  it("carves higher on the halfpipe walls than the center floor", () => {
    expect(pipeHeightAt(80, 200)).toBeGreaterThan(pipeHeightAt(0, 200));
  });

  it("clears a project run at the finish", () => {
    const sim = new PowderRunSim({ width: 220, height: 320, hud: NO_HUD, inputMode: "pointer", projects: DEMO_ARCADE_PROJECTS });
    sim.down(110, 160);
    for (let i = 0; i < 90; i++) sim.step();
    sim.rider.y = RUN_LEN - 2;
    sim.step();
    expect(sim.state).toBe("clear");
    expect(sim.events).toContain("clear");
    expect(sim.result?.grade).toMatch(/[SABC]/);
  });

  it("renders 3D halfpipe frames cleanly", () => {
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
    const sim = new PowderRunSim({ width: 220, height: 320, hud: NO_HUD, inputMode: "pointer", projects: DEMO_ARCADE_PROJECTS });
    const renderer = new PowderRunRenderer(noopBackend, sim);
    expect(renderer.draw()).toBe(1);
    sim.down(110, 160);
    for (let i = 0; i < 90; i++) sim.step();
    expect(renderer.draw()).toBe(2);
  });
});
