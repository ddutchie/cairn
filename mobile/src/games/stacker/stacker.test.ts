import { describe, expect, it } from "vitest";
import { mulberry32 } from "@cairn/shared/arcade/pixel/terrain";
import { PERFECT, StackerSim } from "@cairn/shared/arcade/stacker/sim";
import { SH, stoneSprite } from "@cairn/shared/arcade/stacker/sprites";

function started(seed = 1) {
  const sim = new StackerSim({ width: 180, height: 320, rand: mulberry32(seed) });
  sim.tap();
  return sim;
}

describe("stacker", () => {
  it("starts with a base stone and a stone sliding above it", () => {
    const sim = started();
    expect(sim.state).toBe("play");
    expect(sim.tower).toHaveLength(1);
    expect(sim.mover?.lvl).toBe(1);
    expect(sim.events).toContain("start");
  });

  it("snaps a near-perfect drop and builds a combo", () => {
    const sim = started();
    for (let i = 0; i < 3; i++) {
      sim.mover!.x = sim.top.x + PERFECT;
      sim.tap();
    }
    expect(sim.combo).toBe(3);
    expect(sim.score).toBe(3);
    expect(sim.tower.every((s) => s.x === sim.tower[0].x && s.w === sim.tower[0].w)).toBe(true);
    expect(sim.events.filter((e) => e === "perfect")).toHaveLength(3);
  });

  it("slices the overhang off into debris and keeps the rest of the sprite", () => {
    const sim = started();
    const base = sim.top;
    sim.mover!.x = base.x - 10;
    sim.tap();
    const kept = sim.tower[1];
    expect(kept.w).toBe(base.w - 10);
    expect(kept.x).toBe(base.x);
    expect(kept.sx).toBe(10);
    expect(kept.cut).toBe("left");
    expect(sim.debris).toHaveLength(1);
    expect(sim.debris[0].w).toBe(10);
    expect(sim.combo).toBe(0);
    // The next stone is as wide as what's left.
    expect(sim.mover!.w).toBe(kept.w);
  });

  it("topples on a full miss and retries after the settle", () => {
    const sim = started();
    sim.mover!.x = sim.top.x + sim.top.w + 5;
    sim.tap();
    expect(sim.state).toBe("over");
    expect(sim.events).toContain("over");
    sim.tap();
    expect(sim.state).toBe("over");
    for (let i = 0; i < 41; i++) sim.step();
    sim.tap();
    expect(sim.state).toBe("play");
    expect(sim.score).toBe(0);
  });

  it("raises the camera and the sky as the tower grows", () => {
    const sim = started();
    for (let i = 0; i < 60; i++) {
      sim.mover!.x = sim.top.x;
      sim.tap();
    }
    for (let i = 0; i < 120; i++) sim.step();
    expect(sim.cam).toBeGreaterThan(0);
    expect(sim.altitude).toBeGreaterThan(0.3);
    expect(sim.levelY(sim.top.lvl)).toBeGreaterThan(0);
    expect(sim.levelY(sim.top.lvl)).toBeLessThan(320 - SH);
  });

  it("carves a stone sprite with an outline", () => {
    const px = stoneSprite(40, "card", "Fix sync", 3);
    expect(px.length).toBe(40 * SH * 4);
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255);
    // Top-left pixel is the ink outline.
    expect([px[0], px[1], px[2]]).toEqual([0x0a, 0x0f, 0x1e]);
  });
});
