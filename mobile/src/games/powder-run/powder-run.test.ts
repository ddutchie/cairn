import { describe, expect, it } from "vitest";
import { DEMO_ARCADE_PROJECTS } from "@cairn/shared/arcade/pixel/arcade-data";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import type { PixelBackend, PixelSurface } from "@cairn/shared/arcade/pixel/painter";
import { PowderRunRenderer } from "@cairn/shared/arcade/powder-run/render";
import { PowderRunSim, RUN_LEN, pipeHeightAt } from "@cairn/shared/arcade/powder-run/sim";

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

    // Pop an ollie and throw a midair trick
    expect(sim.triggerAirTrick()).toBe(true);
    expect(sim.rider.air).toBe(true);
    expect(sim.triggerAirTrick()).toBe(true);
    expect(sim.combo).toBe(1);
    expect(sim.score).toBeGreaterThanOrEqual(150);
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
