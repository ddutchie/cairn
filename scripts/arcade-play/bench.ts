/**
 * Arcade frame benchmark (docs/arcade-play.md). Runs a game's sim and
 * renderer in Node against a no-op painter, so it times only the game's own
 * JavaScript: the 3D rasterizer, terrain, and the renderer's bookkeeping.
 * `bench.mjs` runs it with `--jitless`, which interprets like Hermes on the
 * phone, so the numbers rank changes the way the phone does (Chrome's JIT
 * hides most of a hot loop's cost).
 *
 * Args: <game> <width> <height> [frames]. For Wayfinder it lands on each of
 * the first islands and walks the trail, so it times the 3D island stage.
 */
import { DEMO_ARCADE_PROJECTS } from "@cairn/shared/arcade/pixel/arcade-data";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import type { PixelBackend, PixelSurface } from "@cairn/shared/arcade/pixel/painter";
import { TideglassSim } from "@cairn/shared/arcade/tideglass/sim";
import { TideglassRenderer } from "@cairn/shared/arcade/tideglass/render";
import { PowderRunSim } from "@cairn/shared/arcade/powder-run/sim";
import { PowderRunRenderer } from "@cairn/shared/arcade/powder-run/render";
import { AnglerSim } from "@cairn/shared/arcade/angler/sim";
import { AnglerRenderer } from "@cairn/shared/arcade/angler/render";
import { OfficeSim } from "@cairn/shared/arcade/workspace/sim";
import { OfficeRenderer } from "@cairn/shared/arcade/workspace/render";
import { BasecampSim } from "@cairn/shared/arcade/basecamp/sim";
import { BasecampRenderer } from "@cairn/shared/arcade/basecamp/render";
import { WayfinderSim } from "@cairn/shared/arcade/wayfinder/sim";
import { WayfinderRenderer } from "@cairn/shared/arcade/wayfinder/render";
import { LANDING_FRAMES } from "@cairn/shared/arcade/wayfinder/expedition";

const GAMES: Record<string, [any, any]> = {
  tideglass: [TideglassSim, TideglassRenderer],
  "powder-run": [PowderRunSim, PowderRunRenderer],
  angler: [AnglerSim, AnglerRenderer],
  workspace: [OfficeSim, OfficeRenderer],
  basecamp: [BasecampSim, BasecampRenderer],
  wayfinder: [WayfinderSim, WayfinderRenderer],
};

const [name = "wayfinder", w = "233", h = "339", n = "240"] = process.argv.slice(2);
const W = +w, H = +h, FRAMES = +n;
if (!GAMES[name]) throw new Error(`unknown game "${name}": ${Object.keys(GAMES).join(", ")}`);
const [Sim, Ren] = GAMES[name];

/** Counts painter calls: on mobile each one is a native Skia call, so this is the other half of the cost. */
let calls = 0;
const noop = () => {
  calls++;
};
const backend: PixelBackend<unknown, number> = {
  createSurface(width, height): PixelSurface<unknown, number> {
    let sw = width, sh = height, frame = 0;
    return {
      get W() { return sw; },
      get H() { return sh; },
      resize(nw, nh) { sw = nw; sh = nh; },
      clear: noop,
      snapshot: () => ++frame,
      toImage: () => null,
      drawRect: noop,
      drawStrokeRect: noop,
      drawCircle: noop,
      drawLine: noop,
      drawImage: noop,
      drawImageRect: noop,
      drawTintedImage: noop,
      drawSprite: noop,
      drawStack: noop,
      drawShadow: noop,
      drawGlyphs: noop,
      clipRect(_x, _y, _w, _h, fn) { fn(); },
    };
  },
  makeImage: () => ({}),
  makeAtlas: (model) => ({ model, image: {}, shadow: {} }),
};

const times: number[] = [];
let callSum = 0, first = 0;

function run(sim: { step(): void; t?: number }, ren: { draw(): unknown }, frames: number): void {
  for (let i = 0; i < frames; i++) {
    sim.step();
    calls = 0;
    const t0 = performance.now();
    ren.draw();
    times.push(performance.now() - t0);
    callSum += calls;
  }
}

function make() {
  const sim = new Sim({ width: W, height: H, hud: NO_HUD, inputMode: "touch", projects: DEMO_ARCADE_PROJECTS });
  const ren = new Ren(backend, sim);
  // Past the title screen.
  sim.down(W / 2, H / 2);
  sim.up();
  return { sim, ren };
}

if (name === "wayfinder") {
  // Land on a few islands and walk each trail.
  const probe = make();
  const isles = probe.sim.islands.filter((is: { p: unknown }) => is.p).slice(0, 4);
  for (const pick of isles) {
    const { sim, ren } = make();
    const is = sim.islands[probe.sim.islands.indexOf(pick)];
    Object.assign(sim.boat, { x: is.x + is.r * 1.6, y: is.y + is.r * 0.6, v: 0 });
    sim.step();
    sim.land(is);
    const t0 = performance.now();
    ren.draw();
    first = Math.max(first, performance.now() - t0);
    for (let i = 0; i < LANDING_FRAMES; i++) sim.step();
    const e = sim.exp;
    const per = Math.max(1, Math.floor(FRAMES / isles.length / e.deck.length));
    for (let k = 0; k < e.deck.length; k++) {
      e.step = k;
      e.walk = 24;
      run(sim, ren, per);
    }
  }
} else {
  const { sim, ren } = make();
  const t0 = performance.now();
  ren.draw();
  first = performance.now() - t0;
  run(sim, ren, FRAMES);
}

times.sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b, 0) / times.length;
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
console.log(`${name} ${W}×${H}: draw avg ${avg.toFixed(2)} ms · p95 ${pct(0.95).toFixed(2)} · max ${times[times.length - 1].toFixed(2)} · first frame ${first.toFixed(1)} ms · ${(callSum / times.length).toFixed(0)} painter calls/frame · ${times.length} frames`);
