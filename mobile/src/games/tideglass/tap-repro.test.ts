import { describe, expect, it } from "vitest";
import { DEMO_ARCADE_PROJECTS } from "@cairn/shared/arcade/pixel/arcade-data";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import { project } from "@cairn/shared/arcade/pixel/volume";
import { TideglassSim, heightAt } from "@cairn/shared/arcade/tideglass/sim";

function tap(sim: TideglassSim, wx: number, wy: number): void {
  const h = heightAt(wx, wy);
  const p = project(wx, wy, h);
  const sx = p.vx - sim.camVX, sy = p.vy - sim.camVY;
  sim.down(sx, sy);
  sim.up();
}

describe("tap-walk repro", () => {
  it("tap from spawn to mid-mountain actually moves the wick and camera", () => {
    const sim = new TideglassSim({ width: 424, height: 320, hud: NO_HUD, inputMode: "pointer", projects: DEMO_ARCADE_PROJECTS });
    sim.down(212, 160);
    expect(sim.state).toBe("play");
    const x0 = sim.wick.x, y0 = sim.wick.y, cam0x = sim.camVX, cam0y = sim.camVY;
    tap(sim, 540, 700);
    console.log("walkPath after tap:", JSON.stringify(sim.walkPath.slice(0, 6)), "len:", sim.walkPath.length);
    for (let i = 0; i < 600; i++) {
      sim.step();
      if (i % 100 === 0) {
        console.log(`t=${i} wick=(${sim.wick.x.toFixed(1)},${sim.wick.y.toFixed(1)}) cam=(${sim.camVX.toFixed(1)},${sim.camVY.toFixed(1)}) path=${sim.walkPath.length}`);
      }
    }
    console.log(`end wick=(${sim.wick.x.toFixed(1)},${sim.wick.y.toFixed(1)}) cam=(${sim.camVX.toFixed(1)},${sim.camVY.toFixed(1)}) path=${sim.walkPath.length}`);
    expect(Math.hypot(sim.wick.x - x0, sim.wick.y - y0)).toBeGreaterThan(50);
  });
});
