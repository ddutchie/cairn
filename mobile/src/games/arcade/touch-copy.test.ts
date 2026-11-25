import { afterEach, describe, expect, it } from "vitest";
import { DEMO_ARCADE_PROJECTS } from "@cairn/shared/arcade/pixel/arcade-data";
import { NO_HUD, type PixelHud } from "@cairn/shared/arcade/pixel/hud";
import { PixelPainter, type PixelBackend, type PixelSurface } from "@cairn/shared/arcade/pixel/painter";
import { AnglerRenderer } from "@cairn/shared/arcade/angler/render";
import { AnglerSim } from "@cairn/shared/arcade/angler/sim";
import { BasecampRenderer } from "@cairn/shared/arcade/basecamp/render";
import { BasecampSim } from "@cairn/shared/arcade/basecamp/sim";
import { BreakoutRenderer } from "@cairn/shared/arcade/breakout/render";
import { BreakoutSim } from "@cairn/shared/arcade/breakout/sim";
import { InboxZeroRenderer } from "@cairn/shared/arcade/inbox-zero/render";
import { InboxZeroSim } from "@cairn/shared/arcade/inbox-zero/sim";
import { PowderRunRenderer } from "@cairn/shared/arcade/powder-run/render";
import { PowderRunSim } from "@cairn/shared/arcade/powder-run/sim";
import { StackerRenderer } from "@cairn/shared/arcade/stacker/render";
import { StackerSim } from "@cairn/shared/arcade/stacker/sim";
import { TaskForceRenderer } from "@cairn/shared/arcade/task-force/render";
import { TaskForceSim } from "@cairn/shared/arcade/task-force/sim";
import { TideglassRenderer } from "@cairn/shared/arcade/tideglass/render";
import { TideglassSim } from "@cairn/shared/arcade/tideglass/sim";
import { WayfinderRenderer } from "@cairn/shared/arcade/wayfinder/render";
import { WayfinderSim } from "@cairn/shared/arcade/wayfinder/sim";

// On a phone there is no keyboard or mouse: no screen may ask for Space, a click, Esc or the arrows.
const KEYBOARD_COPY = /\b(SPACE|CLICK|PRESS|ESC|ENTER|WASD|ARROWS?)\b|\((E|L|M|ESC|ENTER)\)/;

interface AnySim {
  state: string;
  stateT?: number;
  showLog?: boolean;
  step(): void;
  down?(x: number, y: number): void;
  up?(): void;
  tap?(): void;
}
interface AnyRenderer {
  draw(): unknown;
}
type SimCtor = new (o: { width: number; height: number; hud: PixelHud; inputMode: "touch"; projects: typeof DEMO_ARCADE_PROJECTS }) => AnySim;
type RenCtor = new (b: PixelBackend<unknown, number>, s: AnySim) => AnyRenderer;

const GAMES: [string, unknown, unknown][] = [
  ["angler", AnglerSim, AnglerRenderer],
  ["basecamp", BasecampSim, BasecampRenderer],
  ["breakout", BreakoutSim, BreakoutRenderer],
  ["inbox-zero", InboxZeroSim, InboxZeroRenderer],
  ["powder-run", PowderRunSim, PowderRunRenderer],
  ["stacker", StackerSim, StackerRenderer],
  ["task-force", TaskForceSim, TaskForceRenderer],
  ["tideglass", TideglassSim, TideglassRenderer],
  ["wayfinder", WayfinderSim, WayfinderRenderer],
];

const backend: PixelBackend<unknown, number> = {
  createSurface(width, height): PixelSurface<unknown, number> {
    let w = width, h = height;
    return {
      get W() { return w; },
      get H() { return h; },
      resize(nw, nh) { w = nw; h = nh; },
      clear() {},
      snapshot() { return 0; },
      toImage() { return null; },
      drawRect() {},
      drawStrokeRect() {},
      drawCircle() {},
      drawLine() {},
      drawImage() {},
      drawImageRect() {},
      drawTintedImage() {},
      drawSprite() {},
      drawStack() {},
      drawShadow() {},
      drawGlyphs() {},
      clipRect(_x, _y, _w, _h, fn) { fn(); },
    };
  },
  makeImage: () => ({}),
  makeAtlas: (model) => ({ model, image: {}, shadow: {} }),
};

type TextFn = (this: PixelPainter, s: string, ...rest: unknown[]) => void;
const proto = PixelPainter.prototype as unknown as { text: TextFn };
const originalText = proto.text;
afterEach(() => {
  proto.text = originalText;
});

describe("touch screens never ask for a keyboard or mouse", () => {
  for (const [name, Sim, Ren] of GAMES) {
    it(name, () => {
      const seen = new Set<string>();
      proto.text = function (s, ...rest) {
        seen.add(s);
        return originalText.call(this, s, ...rest);
      };
      const W = 233, H = 320;
      const sim = new (Sim as SimCtor)({ width: W, height: H, hud: NO_HUD, inputMode: "touch", projects: DEMO_ARCADE_PROJECTS });
      const ren = new (Ren as RenCtor)(backend, sim);
      const tap = (x = W / 2, y = H / 2) => {
        if (sim.down) {
          sim.down(x, y);
          sim.up?.();
        } else sim.tap?.();
      };
      // Title, then into play and on for a while, tapping now and then.
      ren.draw();
      tap();
      for (let i = 0; i < 600; i++) {
        sim.step();
        if (i % 20 === 0) ren.draw();
        if (i % 150 === 75) tap(W / 2, H * 0.6);
      }
      if ("showLog" in sim) {
        sim.showLog = true;
        ren.draw();
        sim.showLog = false;
      }
      // The end screen.
      sim.state = "over";
      if ("stateT" in sim) sim.stateT = 200;
      for (let i = 0; i < 40; i++) sim.step();
      ren.draw();

      const bad = [...seen].filter((s) => KEYBOARD_COPY.test(s));
      expect(bad).toEqual([]);
      expect(seen.size).toBeGreaterThan(0);
    });
  }
});
