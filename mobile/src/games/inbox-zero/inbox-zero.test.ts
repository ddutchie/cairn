import { describe, expect, it } from "vitest";
import { DEMO_ARCADE_PROJECTS } from "@/games/pixel/arcade-data";
import { NO_HUD } from "@/games/pixel/hud";
import { CELL, CORE_GX, InboxZeroSim, canBuildCore } from "./sim";

describe("InboxZeroSim", () => {
  it("centers the flow and shop clear of Duo side rails", () => {
    const sim = new InboxZeroSim({
      width: 420,
      height: 320,
      projects: DEMO_ARCADE_PROJECTS,
      hud: { ...NO_HUD, top: 8, bottom: 4, right: 42 },
    });
    expect(sim.coreX).toBe(Math.floor((420 - 42 - CORE_GX * CELL) / 2));
    expect(sim.shopX0).toBeGreaterThanOrEqual(0);
    expect(sim.shopX0 + sim.shopW * 4).toBeLessThanOrEqual(420 - 42);
    expect(sim.shopY + sim.shopH).toBe(320 - 4);
  });

  it("places and upgrades towers beside the flow and rejects path or dead-zone taps", () => {
    const sim = new InboxZeroSim({ width: 320, height: 340, projects: DEMO_ARCADE_PROJECTS });
    // Start game from title
    sim.down(10, 10);
    expect(sim.state).toBe("intro");
    sim.events.length = 0;

    // Tap a path cell (1, 0)
    sim.down(sim.coreX + 1 * CELL + 6, sim.coreY + 6);
    sim.up();
    expect(sim.towers).toHaveLength(0);
    expect(sim.toast?.s).toBe("THAT'S THE FLOW");

    // Tap far out of range
    sim.down(sim.coreX + sim.minC * CELL + 6, sim.coreY + 4 * CELL + 6);
    sim.up();
    expect(sim.towers).toHaveLength(0);
    expect(canBuildCore(sim.minC, 4)).toBe(false);

    // Drag to preview area of effect, then drag back onto shop to cancel
    sim.down(sim.coreX + 2 * CELL + 6, sim.coreY + 1 * CELL + 6);
    expect(sim.cursor).not.toBeNull();
    expect(sim.towers).toHaveLength(0);
    sim.move(sim.coreX + 2 * CELL + 6, sim.shopY + 4);
    sim.up();
    expect(sim.cursor).toBeNull();
    expect(sim.towers).toHaveLength(0);

    // Drag to valid buildable cell (2, 1) and release -> places #QUICK (cost 10)
    sim.down(sim.coreX + 3 * CELL + 6, sim.coreY + 1 * CELL + 6);
    sim.move(sim.coreX + 2 * CELL + 6, sim.coreY + 1 * CELL + 6);
    sim.up();
    expect(sim.towers).toHaveLength(1);
    expect(sim.focus).toBe(30);

    // Tap same tower -> upgrades (cost 8)
    sim.down(sim.coreX + 2 * CELL + 6, sim.coreY + 1 * CELL + 6);
    sim.up();
    expect(sim.towers[0].lvl).toBe(1);
    expect(sim.focus).toBe(22);
    expect(sim.events).toEqual(["error", "error", "place", "upgrade"]);
  });

  it("triage fires on incoming tasks and earns focus and score", () => {
    const sim = new InboxZeroSim({
      width: 180,
      height: 360,
      projects: [{ id: "p1", name: "TEST", accent: "#2ec4b6", biome: "tropic", tasks: [{ title: "TASK", priority: "low", dueMin: 60, overdue: false }], notes: [] }],
    });
    sim.down(10, 10);
    // Place #QUICK right next to the start of the path
    sim.down(sim.coreX + 2 * CELL + 6, sim.coreY + 1 * CELL + 6);
    sim.up();
    for (let i = 0; i < 600 && sim.state !== "win"; i++) sim.step();
    expect(sim.state).toBe("win");
    expect(sim.triaged).toBe(1);
    expect(sim.score).toBeGreaterThan(0);
  });
});
