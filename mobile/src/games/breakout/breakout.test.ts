import { describe, expect, it } from "vitest";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import { mulberry32 } from "@cairn/shared/arcade/pixel/terrain";
import { BreakoutSim, MAX_COLS, MIN_COLS, ROWS } from "@cairn/shared/arcade/breakout/sim";

function started(width = 180, seed = 1) {
  const sim = new BreakoutSim({ width, height: 320, rand: mulberry32(seed) });
  sim.tap();
  return sim;
}

describe("breakout", () => {
  it("fits the grid to the playfield", () => {
    expect(started(180).cols).toBe(MIN_COLS);
    expect(started(600).cols).toBe(MAX_COLS);
    const sim = started(180);
    expect(sim.bricks).toHaveLength(ROWS * MIN_COLS);
    for (const b of sim.bricks) {
      expect(b.x - 13).toBeGreaterThanOrEqual(sim.left);
      expect(b.x + 13).toBeLessThanOrEqual(sim.right);
    }
  });

  it("moves the live bricks down when the HUD lowers the ceiling", () => {
    const sim = started(180);
    sim.bricks.splice(0, 3);
    const ys = sim.bricks.map((b) => b.y);
    sim.resize(180, 320, { ...NO_HUD, top: 40 });
    expect(sim.bricks).toHaveLength(ys.length);
    sim.bricks.forEach((b, i) => expect(b.y).toBe(ys[i] + 40));
    // Same HUD again: nothing moves.
    sim.resize(180, 320, { ...NO_HUD, top: 40 });
    sim.bricks.forEach((b, i) => expect(b.y).toBe(ys[i] + 40));
  });

  it("keeps the ball out of the side rail", () => {
    const sim = new BreakoutSim({ width: 240, height: 320, hud: { ...NO_HUD, right: 30 }, rand: mulberry32(2) });
    expect(sim.right).toBe(210);
    sim.tap();
    sim.tap();
    sim.bricks = [];
    Object.assign(sim.ball, { x: 200, y: 200, vx: 3, vy: 0.2 });
    let bounced = false;
    for (let i = 0; i < 20; i++) {
      sim.step();
      expect(sim.ball.x + 2).toBeLessThanOrEqual(210);
      if (sim.ball.vx < 0) bounced = true;
    }
    expect(bounced).toBe(true);
  });

  it("waits on the paddle until a tap, then breaks bricks", () => {
    const sim = started();
    expect(sim.ball.stuck).toBe(true);
    for (let i = 0; i < 30; i++) sim.step();
    expect(sim.ball.stuck).toBe(true);
    sim.tap();
    expect(sim.ball.stuck).toBe(false);
    let broke = 0;
    for (let i = 0; i < 4000 && sim.state === "play"; i++) {
      sim.aim(sim.ball.x + 4);
      sim.step();
      broke += sim.events.filter((e) => e === "brick" || e === "streak").length;
      sim.events.length = 0;
    }
    expect(broke).toBeGreaterThan(5);
    expect(sim.score).toBe(broke);
    expect(sim.best).toBe(sim.score);
  });

  it("wins on an empty board and loses when the ball drops", () => {
    const sim = started();
    sim.tap();
    while (sim.bricks.length) sim.breakBrick(sim.bricks.shift()!);
    expect(sim.state).toBe("win");
    expect(sim.events).toContain("win");

    const lost = started();
    lost.tap();
    Object.assign(lost.ball, { x: 10, y: 330, vx: 0, vy: 3 });
    lost.aim(170);
    lost.step();
    expect(lost.state).toBe("over");
    for (let i = 0; i < 41; i++) lost.step();
    lost.tap();
    expect(lost.state).toBe("play");
    expect(lost.terrainGen).toBe(2);
  });
});
