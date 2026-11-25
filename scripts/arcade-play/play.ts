/**
 * Arcade play harness: runs one shared arcade game (sim + renderer) in a
 * browser canvas, with no Electron or Expo around it. See docs/arcade-play.md.
 *
 * URL: ?g=<game>&w=<width>&h=<height>&k=<zoom>[&duo=1][&touch=1]
 * Console: window.sim, window.ren, window.paused, window.measure(n), window.calls(), window.landAt(i) (Wayfinder)
 */
import { DEMO_ARCADE_PROJECTS } from "@cairn/shared/arcade/pixel/arcade-data";
import { NO_HUD, type PixelHud } from "@cairn/shared/arcade/pixel/hud";
import { createCanvasBackend } from "@app/components/arcade/pixel/canvas-backend";
import { TideglassSim } from "@cairn/shared/arcade/tideglass/sim";
import { TideglassRenderer } from "@cairn/shared/arcade/tideglass/render";
import { PowderRunSim } from "@cairn/shared/arcade/powder-run/sim";
import { PowderRunRenderer } from "@cairn/shared/arcade/powder-run/render";
import { AnglerSim } from "@cairn/shared/arcade/angler/sim";
import { AnglerRenderer } from "@cairn/shared/arcade/angler/render";
import { BasecampSim } from "@cairn/shared/arcade/basecamp/sim";
import { BasecampRenderer } from "@cairn/shared/arcade/basecamp/render";
import { WayfinderSim } from "@cairn/shared/arcade/wayfinder/sim";
import { WayfinderRenderer } from "@cairn/shared/arcade/wayfinder/render";

const GAMES: Record<string, [any, any]> = {
  tideglass: [TideglassSim, TideglassRenderer],
  "powder-run": [PowderRunSim, PowderRunRenderer],
  angler: [AnglerSim, AnglerRenderer],
  basecamp: [BasecampSim, BasecampRenderer],
  wayfinder: [WayfinderSim, WayfinderRenderer],
};
const q = new URLSearchParams(location.search);
const name = q.get("g") ?? "tideglass";
const W = +(q.get("w") ?? 233), H = +(q.get("h") ?? 320), K = +(q.get("k") ?? 2);
// A rough iPhone Duo cut-out: the HUD keeps clear of the corners and the top-right sensor.
const hud: PixelHud = q.get("duo") === "1" ? { ...NO_HUD, top: 6, right: 28, topLeft: 10, topRight: 30, bottomLeft: 10, bottomRight: 30 } : NO_HUD;
const canvas = document.getElementById("c") as HTMLCanvasElement;
canvas.width = W;
canvas.height = H;
canvas.style.width = W * K + "px";
canvas.style.height = H * K + "px";
if (!GAMES[name]) throw new Error(`unknown game "${name}": ${Object.keys(GAMES).join(", ")}`);
const [Sim, Ren] = GAMES[name];
const sim = new Sim({ width: W, height: H, hud, inputMode: q.get("touch") ? "touch" : "pointer", projects: DEMO_ARCADE_PROJECTS });
const ren = new Ren(createCanvasBackend(canvas), sim);
const win = window as any;
win.sim = sim;
win.ren = ren;
win.paused = false;

/** Average draw time over `n` frames, advancing only the clock (pause first for a still scene). */
win.measure = (n = 60): number => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    sim.t++;
    ren.draw();
  }
  return (performance.now() - t0) / n;
};

/** Surface calls made by one frame: the Skia cost on mobile follows this count. */
win.calls = (): Record<string, number> => {
  const sf = ren.surface, counts: Record<string, number> = {}, orig: Record<string, any> = {};
  for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(sf))) {
    if (!k.startsWith("draw") || typeof sf[k] !== "function") continue;
    orig[k] = sf[k];
    sf[k] = function (...a: unknown[]) {
      counts[k] = (counts[k] ?? 0) + 1;
      return orig[k].apply(this, a);
    };
  }
  ren.draw();
  for (const k in orig) sf[k] = orig[k];
  return counts;
};

/** Wayfinder: sail alongside island `i` (default: the first unexplored), settle the camera, and land. */
win.landAt = (i?: number): void => {
  const is = i === undefined ? sim.islands.find((x: { explored: boolean }) => !x.explored) : sim.islands[i];
  sim.state = "sail";
  sim.boat.x = is.x + is.r * 1.6;
  sim.boat.y = is.y + is.r * 0.6;
  sim.boat.v = 0;
  for (let k = 0; k < 90; k++) sim.step();
  sim.state = "sail";
  sim.land(is);
};

const ms = document.getElementById("ms")!;
const pos = (e: PointerEvent) => {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
};
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = pos(e);
  sim.down(x, y);
});
canvas.addEventListener("pointermove", (e) => {
  if (!e.buttons) return;
  const [x, y] = pos(e);
  sim.move(x, y, 0, 0);
});
canvas.addEventListener("pointerup", () => sim.up?.());
addEventListener("keydown", (e) => {
  if (!e.repeat && sim.setKey?.(e.code, true)) e.preventDefault();
});
addEventListener("keyup", (e) => sim.setKey?.(e.code, false));

let last = performance.now(), acc = 0, drawT = 0, frames = 0;
const tick = (now: number) => {
  acc += Math.min(100, now - last);
  last = now;
  if (win.paused) acc = 0;
  while (acc >= 1000 / 60) {
    sim.step();
    acc -= 1000 / 60;
  }
  const t = performance.now();
  ren.draw();
  drawT += performance.now() - t;
  if (++frames % 30 === 0) {
    ms.textContent = `${name} ${W}x${H} draw ${(drawT / 30).toFixed(1)}ms state=${sim.state}`;
    drawT = 0;
  }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
