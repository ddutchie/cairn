import { describe, expect, it } from "vitest";
import { DEMO_ARCADE_PROJECTS } from "./arcade-data";
import { NO_HUD, type PixelHud } from "./hud";
import { AnglerSim } from "../angler/sim";
import { BasecampSim } from "../basecamp/sim";
import { BreakoutSim } from "../breakout/sim";
import { InboxZeroSim } from "../inbox-zero/sim";
import { PowderRunSim } from "../powder-run/sim";
import { StackerSim } from "../stacker/sim";
import { TaskForceSim } from "../task-force/sim";
import { TideglassSim } from "../tideglass/sim";
import { WayfinderSim } from "../wayfinder/sim";

// Unfolding the Duo resizes the playfield (and its insets) under a running game; the game must carry on.
const wide: PixelHud = { ...NO_HUD, top: 6, bottom: 4, left: 10, right: 10 };
const sims = {
  angler: AnglerSim, basecamp: BasecampSim, breakout: BreakoutSim, "inbox-zero": InboxZeroSim, "powder-run": PowderRunSim,
  stacker: StackerSim, "task-force": TaskForceSim, tideglass: TideglassSim, wayfinder: WayfinderSim,
} as const;

describe("live resize keeps the run", () => {
  for (const [name, Sim] of Object.entries(sims)) {
    it(name, () => {
      const sim = new (Sim as any)({ width: 233, height: 320, hud: NO_HUD, inputMode: "touch", projects: DEMO_ARCADE_PROJECTS });
      sim.down?.(116, 160);
      sim.up?.();
      for (let i = 0; i < 90; i++) sim.step();
      const before = sim.t;
      sim.resize(320, 320, wide);
      for (let i = 0; i < 90; i++) sim.step();
      expect([sim.W, sim.H]).toEqual([320, 320]);
      expect(sim.hud).toBe(wide);
      // Same sim object, still ticking: nothing was rebuilt.
      expect(sim.t).toBe(before + 90);
    });
  }
});
