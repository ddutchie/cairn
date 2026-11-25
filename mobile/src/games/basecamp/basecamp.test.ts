import { describe, expect, it } from "vitest";
import { DEMO_ARCADE_PROJECTS } from "@cairn/shared/arcade/pixel/arcade-data";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import type { PixelBackend, PixelSurface } from "@cairn/shared/arcade/pixel/painter";
import { BasecampRenderer } from "@cairn/shared/arcade/basecamp/render";
import {
  BELL_POS,
  BasecampSim,
  CAIRN_POS,
  CHEST_POS,
  CYCLE_FRAMES,
  HEARTH_POS,
  RADIO_POS,
  SLUICE_POS,
  UPGRADE_TIMBER,
} from "@cairn/shared/arcade/basecamp/sim";

function startSim(width = 220, height = 320, inputMode: "touch" | "pointer" = "pointer"): BasecampSim {
  const sim = new BasecampSim({
    width,
    height,
    hud: NO_HUD,
    inputMode,
    projects: DEMO_ARCADE_PROJECTS,
  });
  sim.down(width / 2, height / 2);
  expect(sim.state).toBe("play");
  return sim;
}

describe("BasecampSim", () => {
  it("seeds lodges, settlers, and overdue brambles from Cairn workspace projects", () => {
    const sim = startSim();
    expect(sim.lodges.length).toBeGreaterThanOrEqual(4);
    expect(sim.settlers).toHaveLength(sim.lodges.length);
    expect(sim.brambles.length).toBeGreaterThan(0);
    expect(sim.braziers).toHaveLength(3);
  });

  it("moves the Warden with WASD and quick-tap walk target", () => {
    const sim = startSim(240, 320, "pointer");
    const startY = sim.warden.y;
    sim.setKey("KeyW", true);
    for (let i = 0; i < 12; i++) sim.step();
    sim.setKey("KeyW", false);
    expect(sim.warden.y).toBeLessThan(startY);

    // Quick tap to set walkTarget
    const beforeX = sim.warden.x;
    sim.down(200, 160);
    sim.up();
    for (let i = 0; i < 12; i++) sim.step();
    expect(sim.warden.x).toBeGreaterThan(beforeX);
  });

  it("unlocks Watchfires after carrying Hearth ember to all 3 braziers", () => {
    const sim = startSim();
    // Near Hearthfire -> ember lights
    sim.warden.x = HEARTH_POS.x + 14;
    sim.warden.y = HEARTH_POS.y;
    sim.step();
    expect(sim.warden.hasEmber).toBe(true);

    for (const br of sim.braziers) {
      sim.warden.x = br.x;
      sim.warden.y = br.y + 8;
      sim.step();
      expect(sim.interact()).toBe(true);
    }

    expect(sim.litBraziersCount).toBe(3);
    expect(sim.secrets.has("watchfires")).toBe(true);
  });

  it("drains the pond when Sluice opens and reveals the Sunken Chest at Night", () => {
    const sim = startSim();
    // Flip Mill Sluice
    sim.warden.x = SLUICE_POS.x;
    sim.warden.y = SLUICE_POS.y + 10;
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(sim.sluiceOpen).toBe(true);
    expect(sim.causewayOpen).toBe(false);

    // Advance into Night phase
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.8));
    expect(sim.phase).toBe("night");
    expect(sim.causewayOpen).toBe(true);

    // Walk across stepping stones and open Sunken Chest
    sim.warden.x = CHEST_POS.x;
    sim.warden.y = CHEST_POS.y;
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(sim.chestOpened).toBe(true);
    expect(sim.secrets.has("causeway")).toBe(true);
  });

  it("unlocks Dusk Broadcast when East Bell rings at Dusk and South Tower is tuned", () => {
    const sim = startSim();
    // Advance into Dusk (~0.6 of cycle)
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.55));
    expect(sim.phase).toBe("dusk");

    sim.warden.x = BELL_POS.x;
    sim.warden.y = BELL_POS.y + 10;
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(sim.duskBellRung).toBe(true);

    sim.warden.x = RADIO_POS.x;
    sim.warden.y = RADIO_POS.y + 10;
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(sim.secrets.has("dusk-bell")).toBe(true);
  });

  it("clears brambles, upgrades lodges, awakens the Fifth Cairn, and toggles Field Log", () => {
    const sim = startSim();
    // Open & close Field Log via top-right pill + Escape
    const lb = sim.logButtonRect();
    sim.down(lb.x + 2, lb.y + 2);
    expect(sim.showLog).toBe(true);
    expect(sim.setKey("Escape", true)).toBe(true);
    expect(sim.showLog).toBe(false);
    // Escape when log is closed yields back to menu
    expect(sim.setKey("Escape", true)).toBe(false);

    // Clear a bramble
    const bramble = sim.brambles[0];
    sim.warden.x = bramble.x;
    sim.warden.y = bramble.y;
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(bramble.cleared).toBe(true);

    // Upgrade 3 lodges to unlock Camp Thriving
    sim.timber = UPGRADE_TIMBER * 3;
    for (let i = 0; i < 3; i++) {
      const l = sim.lodges[i];
      sim.warden.x = l.x;
      sim.warden.y = l.y + 10;
      sim.step();
      expect(sim.interact()).toBe(true);
      expect(l.level).toBe(2);
    }
    expect(sim.secrets.has("workshops")).toBe(true);

    // Awaken Fifth Cairn with 3 sparks + >=2 secrets
    sim.sparks = 3;
    // Unlock a second secret first via watchfires
    sim.warden.hasEmber = true;
    for (const br of sim.braziers) {
      sim.warden.x = br.x;
      sim.warden.y = br.y + 8;
      sim.step();
      sim.interact();
    }
    expect(sim.secrets.size).toBeGreaterThanOrEqual(2);

    sim.warden.x = CAIRN_POS.x;
    sim.warden.y = CAIRN_POS.y + 10;
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(sim.cairnAwakened).toBe(true);
    expect(sim.secrets.has("cairn")).toBe(true);
    expect(sim.score).toBeGreaterThan(1000);
  });

  it("renders title, play, dusk/night causeway, Field Log, and Duo resize without errors", () => {
    let snapshots = 0;
    const noopBackend: PixelBackend<unknown, number> = {
      createSurface(width, height): PixelSurface<unknown, number> {
        let w = width, h = height;
        return {
          get W() { return w; },
          get H() { return h; },
          resize(nw, nh) { w = nw; h = nh; },
          clear() {},
          snapshot() { return ++snapshots; },
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

    const sim = new BasecampSim({ width: 180, height: 320, hud: { ...NO_HUD, top: 8 }, projects: DEMO_ARCADE_PROJECTS });
    const renderer = new BasecampRenderer(noopBackend, sim);
    expect(renderer.draw()).toBe(1);

    sim.down(90, 160);
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.8));
    sim.sluiceOpen = true;
    sim.step();
    expect(renderer.draw()).toBe(2);

    sim.showLog = true;
    expect(renderer.draw()).toBe(3);

    // Unfold to wide Duo layout
    renderer.resize(520, 320);
    expect(sim.W).toBe(520);
    expect(renderer.draw()).toBe(4);
  });
});
