import { describe, expect, it } from "vitest";
import { VOL, camFor, depthOf, project, unproject } from "./volume";
import { heightAt } from "../tideglass/sim";

describe("volume projection", () => {
  it("centers the origin and lifts height straight up-screen", () => {
    const p = project(220, 220, 0);
    expect(p.vx).toBeCloseTo(VOL.cx, 6);
    expect(p.vy).toBeCloseTo(440 * VOL.oy + VOL.cy, 6);
    const up = project(220, 220, 2);
    expect(up.vx).toBeCloseTo(p.vx, 6);
    expect(up.vy).toBeCloseTo(p.vy - 2 * VOL.zh, 6);
  });

  it("orders depth southward", () => {
    expect(depthOf(220, 84)).toBeLessThan(depthOf(220, 222));
    expect(depthOf(220, 222)).toBeLessThan(depthOf(220, 336));
  });

  it("round-trips taps through the real heightfield", () => {
    for (const [x, y] of [[220, 112], [100, 200], [344, 304], [220, 336], [268, 188]] as const) {
      const h = heightAt(x, y);
      const p = project(x, y, h);
      const w = unproject(p.vx, p.vy, heightAt);
      expect(Math.hypot(w.x - x, w.y - y)).toBeLessThan(3);
    }
  });

  it("clamps the camera inside the volume", () => {
    const c = camFor(250, 150, 220, 320);
    expect(c.cx).toBeGreaterThanOrEqual(0);
    expect(c.cx).toBeLessThanOrEqual(VOL.vw - 220);
    expect(c.cy).toBeGreaterThanOrEqual(0);
    expect(c.cy).toBeLessThanOrEqual(Math.max(0, VOL.vh - 320));
  });
});
