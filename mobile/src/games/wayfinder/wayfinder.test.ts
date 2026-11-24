import { describe, expect, it } from "vitest";
import { DEMO_ARCADE_PROJECTS } from "@cairn/shared/arcade/pixel/arcade-data";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import { WD, WayfinderSim } from "@cairn/shared/arcade/wayfinder/sim";

describe("WayfinderSim", () => {
  it("builds harbours, note islands, crates, and overdue storms from workspace projects", () => {
    const sim = new WayfinderSim({ width: 200, height: 360, projects: DEMO_ARCADE_PROJECTS });
    expect(sim.harbours.length).toBeGreaterThanOrEqual(4);
    expect(sim.islands.length).toBeGreaterThanOrEqual(10);
    expect(sim.allCrates.length).toBeGreaterThan(0);
    expect(sim.stormTasks.length).toBeGreaterThan(0);
    expect(sim.worldPixels.length).toBe(WD * 900 * 4);
  });

  it("steers on drag, clears steering on finger lift, and toggles the map", () => {
    const sim = new WayfinderSim({ width: 220, height: 380, projects: DEMO_ARCADE_PROJECTS, hud: { ...NO_HUD, top: 10 } });
    // Start sailing
    sim.down(110, 200);
    expect(sim.state).toBe("sail");
    expect(sim.events).toContain("start");

    // Drag to steer, then lift finger
    sim.down(160, 140);
    expect(sim.steer).toEqual({ x: 160, y: 140 });
    sim.move(170, 130);
    expect(sim.steer).toEqual({ x: 170, y: 130 });
    sim.step();
    expect(sim.boat.v).toBeGreaterThan(0);
    sim.up();
    expect(sim.steer).toBeNull();

    // Tap map button (top-left under hud.top)
    sim.down(12, 20);
    expect(sim.state).toBe("map");
    // Tap again to close map
    sim.down(110, 200);
    expect(sim.state).toBe("sail");
  });

  it("loads crates at Today and centers camX on wide unfolded screens", () => {
    const sim = new WayfinderSim({ width: 700, height: 320, projects: DEMO_ARCADE_PROJECTS });
    sim.down(100, 100);
    for (let i = 0; i < 10; i++) sim.step();
    expect(sim.camX).toBe(Math.round((WD - 700) / 2));
    // Boat starts near Today lighthouse so crates load immediately
    expect(sim.boat.cargo.length).toBeGreaterThan(0);
    expect(sim.events).toContain("load");
  });

  it("bobs gently in place on the title screen with fishing and swimming crew", () => {
    const sim = new WayfinderSim({ width: 220, height: 380, projects: DEMO_ARCADE_PROJECTS });
    const startX = sim.boat.x;
    const startY = sim.boat.y;
    for (let i = 0; i < 240; i++) sim.step();
    expect(sim.boat.x).toBe(startX);
    expect(sim.boat.y).toBe(startY);
    expect(Math.abs(sim.boat.a)).toBeLessThanOrEqual(0.15);
    expect(sim.crew.cast).toBeGreaterThan(0);
    expect(sim.crew.swim).toBe("swim");
    expect(sim.score).toBe(0);
    expect(sim.events).toEqual([]);
  });
});
