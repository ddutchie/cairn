import { describe, expect, it } from "vitest";
import { clip, fontAtlasPixels, glyphIndices, CHARSET, textWidth } from "@/games/pixel/font";
import { ENEMIES, PLAYER } from "./models";
import { makeModel } from "@/games/pixel/models";
import { DEMO_LEVELS, TaskForceSim, type Level } from "./sim";
import { CHUNK, MARGIN, SEA, Terrain, chunkTop, mulberry32, visibleChunks } from "@/games/pixel/terrain";

describe("terrain", () => {
  it("is deterministic for a seed", () => {
    const a = new Terrain(120, "tropic", 3), b = new Terrain(120, "tropic", 3);
    expect(a.chunk(2).pixels[0]).toEqual(b.chunk(2).pixels[0]);
    expect(new Terrain(120, "tropic", 4).chunk(2).pixels[0]).not.toEqual(a.chunk(2).pixels[0]);
  });

  it("is mostly sea with islands", () => {
    const t = new Terrain(180, "tropic", 3);
    let land = 0, n = 0;
    for (let r = 0; r < 4000; r += 9) for (let x = 0; x < 180; x += 6, n++) if (t.heightAt(x, r) >= SEA) land++;
    expect(land / n).toBeGreaterThan(0.2);
    expect(land / n).toBeLessThan(0.5);
  });

  it("bakes opaque chunks with a strip margin on both sides", () => {
    const t = new Terrain(150, "volcano", 9);
    const c = t.chunk(0);
    expect(t.width).toBe(150 + MARGIN * 2);
    expect(c.pixels[0].length).toBe(t.width * CHUNK * 4);
    // Every pixel is painted (ray casting fills each column to the top).
    for (let i = 3; i < c.pixels[0].length; i += 4) expect(c.pixels[0][i]).toBe(255);
  });

  it("covers the whole screen with visible chunks", () => {
    for (const camR of [0, 37.5, 128, 999.4]) {
      const H = 300, vis = visibleChunks(camR, H);
      const covered = new Uint8Array(H);
      for (const c of vis) for (let y = chunkTop(c, camR, H); y < chunkTop(c, camR, H) + CHUNK; y++) if (y >= 0 && y < H) covered[y] = 1;
      expect(covered.every((v) => v === 1)).toBe(true);
    }
  });
});

describe("models", () => {
  it("pads every layer by a pixel and outlines it", () => {
    const m = makeModel(3, 3, 1, (x, y) => (x === 1 && y === 1 ? "#ffffff" : null));
    expect([m.w, m.d, m.h]).toEqual([5, 5, 1]);
    const alpha = (buf: Uint8Array, x: number, y: number) => buf[(y * m.w + x) * 4 + 3];
    expect(alpha(m.layers[0], 2, 2)).toBe(255);
    expect([alpha(m.outline[0], 1, 2), alpha(m.outline[0], 3, 2), alpha(m.outline[0], 2, 1), alpha(m.outline[0], 2, 3)]).toEqual([255, 255, 255, 255]);
    expect(alpha(m.outline[0], 2, 2)).toBe(0);
  });

  it("builds the fleet", () => {
    expect([PLAYER.w, PLAYER.d, PLAYER.h]).toEqual([17, 21, 6]);
    expect(ENEMIES.urgent.h).toBeGreaterThan(ENEMIES.low.h);
  });
});

describe("font", () => {
  it("maps characters to atlas cells, unknown to ?", () => {
    expect(glyphIndices("a?é")).toEqual([CHARSET.indexOf("A"), CHARSET.indexOf("?"), CHARSET.indexOf("?")]);
    expect(textWidth("ABC")).toBe(11);
    expect(textWidth("ABC", 2)).toBe(22);
    expect(clip("Fix sync conflict", 8)).toBe("Fix syn.");
    expect(fontAtlasPixels().w).toBe(CHARSET.length * 4);
  });
});

/** Fly under the nearest threat and let auto-fire do the rest. */
function autopilot(sim: TaskForceSim): void {
  const target = sim.boss ?? sim.enemies.reduce<{ x: number; y: number } | null>((best, e) => (!best || e.y > best.y ? e : best), null);
  if (target) sim.nudge(Math.sign(target.x - sim.player.tx) * Math.min(3, Math.abs(target.x - sim.player.tx)), 0);
}

describe("sim", () => {
  const level: Level = {
    name: "Test",
    biome: "tropic",
    tasks: [
      { title: "a", priority: "low" },
      { title: "b", priority: "medium" },
      { title: "c", priority: "high" },
    ],
    notes: ["n"],
  };

  it("starts on tap and turns each task into one enemy", () => {
    const sim = new TaskForceSim({ width: 180, height: 320, levels: [level], rand: mulberry32(1) });
    expect(sim.state).toBe("title");
    sim.tap();
    expect(sim.state).toBe("intro");
    expect(sim.total).toBe(3);
    expect(sim.events).toContain("start");
  });

  it("clears a level, fights the boss and loops", () => {
    const sim = new TaskForceSim({ width: 180, height: 320, levels: [level], rand: mulberry32(2) });
    sim.tap();
    sim.lives = 999;
    const seen = new Set<string>();
    for (let i = 0; i < 20000 && sim.state !== "win"; i++) {
      autopilot(sim);
      sim.step();
      seen.add(sim.state);
      for (const e of sim.events) seen.add(e);
      sim.events.length = 0;
    }
    expect(sim.state).toBe("win");
    expect(sim.done).toBe(3);
    for (const k of ["play", "boss", "kill", "boss-down", "clear"]) expect(seen).toContain(k);
    expect(sim.loop).toBe(1);
    expect(sim.best).toBeGreaterThan(0);
    // "Tap to continue" appears once the banner settles, and starts the harder loop.
    sim.tap();
    expect(sim.state).toBe("win");
    for (let i = 0; i < 61; i++) sim.step();
    sim.tap();
    expect(sim.state).toBe("intro");
    expect(sim.loop).toBe(1);
  });

  it("brings back tasks that slip past", () => {
    const sim = new TaskForceSim({ width: 180, height: 320, levels: [{ ...level, tasks: [{ title: "slip", priority: "low" }] }], rand: mulberry32(3) });
    sim.tap();
    sim.player.fire = 1e9; // never shoots
    sim.player.inv = 1e9;
    let carried = 0;
    for (let i = 0; i < 1500; i++) {
      sim.step();
      carried += sim.events.filter((e) => e === "carried").length;
      sim.events.length = 0;
    }
    expect(carried).toBeGreaterThan(0);
    expect(sim.done).toBe(0);
    expect(sim.state).toBe("play");
  });

  it("ends the run when the last heart goes", () => {
    const sim = new TaskForceSim({ width: 180, height: 320, levels: DEMO_LEVELS, rand: mulberry32(4) });
    sim.tap();
    sim.lives = 1;
    sim.player.inv = 0;
    sim.ebul.push({ x: sim.player.x, y: sim.player.y, vx: 0, vy: 0 });
    sim.step();
    expect(sim.state).toBe("over");
    expect(sim.events).toContain("over");
  });
});
