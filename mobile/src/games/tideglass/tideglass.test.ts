import { describe, expect, it } from "vitest";
import { DEMO_ARCADE_PROJECTS, type ArcadeProject } from "@cairn/shared/arcade/pixel/arcade-data";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import type { PixelBackend, PixelSurface } from "@cairn/shared/arcade/pixel/painter";
import { TideglassRenderer } from "@cairn/shared/arcade/tideglass/render";
import {
  CHEST_POS,
  CLIFFS,
  CYCLE_FRAMES,
  isSea,
  DOCK_POS,
  HUT_POS,
  LIGHTHOUSE_POS,
  MILL_POS,
  RADIO_POS,
  SUMMIT_START,
  TRAIL,
  TideglassSim,
  VAULT_POS,
  WORLD_W,
  altZone,
  heightAt,
  seedFromWorkspace,
  trailDist,
} from "@cairn/shared/arcade/tideglass/sim";
import { project } from "@cairn/shared/arcade/pixel/volume";

function startSim(width = 220, height = 320): TideglassSim {
  const sim = new TideglassSim({ width, height, hud: NO_HUD, inputMode: "pointer", projects: DEMO_ARCADE_PROJECTS });
  sim.down(width / 2, height / 2);
  expect(sim.state).toBe("play");
  return sim;
}

describe("TideglassSim", () => {
  it("starts a 3-minute loop with four scheduled islanders", () => {
    const sim = startSim();
    expect(sim.npcs.map((n) => n.id)).toEqual(["mira", "ios", "june", "piotr"]);
    expect(sim.phase).toBe("calm");
    expect(sim.sluiceOpen).toBe(true);
  });

  it("falls from summit to shore: height drops and zones read top to bottom", () => {
    expect(heightAt(540, 120)).toBeGreaterThan(heightAt(540, 640));
    expect(heightAt(540, 640)).toBeGreaterThan(heightAt(540, 1180));
    expect(altZone(heightAt(540, 120))).toBe("PEAK");
    expect(altZone(heightAt(540, 640))).toBe("ALPINE");
    expect(altZone(heightAt(540, 1180))).toBe("SHORE");
    expect(trailDist(TRAIL[2].x, TRAIL[2].y)).toBeLessThan(1);
  });

  it("runs one journey with no reset: the day holds at ebb", () => {
    const sim = startSim();
    expect(sim.wick.x).toBe(SUMMIT_START.x);
    expect(sim.wick.y).toBe(SUMMIT_START.y);
    sim.wick.x = 540;
    sim.wick.y = 1180;
    sim.step();
    expect(sim.visitedZones.has("SHORE")).toBe(true);
    sim.advanceClock(CYCLE_FRAMES + 10);
    expect(sim.loop).toBe(1);
    expect(sim.phase).toBe("ebb");
    // No reset: the wick and its notebook persist.
    expect(sim.wick.x).toBe(540);
    expect(sim.visitedZones.has("SHORE")).toBe(true);
    expect(sim.dayEnded).toBe(true);
  });

  it("blocks climbing the cliff off-trail but lets the descent through", () => {
    const sim = startSim();
    // Below the first cliff, off the pass: pushing north goes nowhere.
    sim.wick.x = 200;
    sim.wick.y = 338;
    sim.step();
    sim.setKey("ArrowUp", true);
    for (let i = 0; i < 30; i++) sim.step();
    sim.setKey("ArrowUp", false);
    expect(sim.wick.y).toBeGreaterThanOrEqual(330);
    // Through the pass the trail climbs.
    sim.wick.x = 530;
    sim.wick.y = 338;
    sim.step();
    sim.setKey("ArrowUp", true);
    for (let i = 0; i < 40; i++) sim.step();
    sim.setKey("ArrowUp", false);
    expect(sim.wick.y).toBeLessThan(330);
  });

  it("treats cliffs as one-way: drops fall south, climbs need the pass", () => {
    const sim = startSim();
    expect(sim.canStep(200, 338, 200, 322)).toBe(false);
    expect(sim.canStep(200, 322, 200, 338)).toBe(true);
    expect(sim.canStep(530, 338, 530, 322)).toBe(true);
  });

  it("routes paths around the cliff through the pass", () => {
    const sim = startSim();
    const path = sim.findPath(200, 360, 200, 300);
    expect(path.length).toBeGreaterThan(0);
    // Walk it: the wick gets over the wall, never crossing it off-pass.
    sim.wick.x = 200;
    sim.wick.y = 360;
    sim.step();
    sim.walkPath = sim.findPath(200, 360, 200, 300);
    let prev = { x: sim.wick.x, y: sim.wick.y };
    for (let i = 0; i < 600 && sim.walkPath.length; i++) {
      sim.step();
      const cur = { x: sim.wick.x, y: sim.wick.y };
      if (prev.y >= 330 && cur.y < 330 && cur.x >= 140 && cur.x <= 700) {
        // A northward wall crossing must happen inside a pass gap.
        expect(cur.x).toBeGreaterThanOrEqual(465);
        expect(cur.x).toBeLessThanOrEqual(595);
      }
      prev = cur;
    }
    expect(sim.wick.y).toBeLessThan(330);
  });

  it("walks islanders along the trail instead of through cliffs", () => {
    const sim = startSim();
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.5));
    const prev = new Map(sim.npcs.map((n) => [n.id, { x: n.x, y: n.y }]));
    for (let i = 0; i < 200; i++) {
      sim.step();
      for (const n of sim.npcs) {
        expect(n.x).toBeGreaterThanOrEqual(10);
        expect(n.x).toBeLessThanOrEqual(WORLD_W + 60);
        const p = prev.get(n.id)!;
        for (const c of CLIFFS) {
          // A northward wall crossing must happen inside a pass gap.
          if (p.y >= c.y && n.y < c.y && n.x >= c.x0 && n.x <= c.x1) {
            expect(n.x).toBeGreaterThanOrEqual(c.gap0 - 5);
            expect(n.x).toBeLessThanOrEqual(c.gap1 + 5);
          }
        }
        prev.set(n.id, { x: n.x, y: n.y });
      }
    }
  });

  it("locks the sluice at 0:40 unless jammed with driftwood gear", () => {
    const sim = startSim();
    sim.wick.x = MILL_POS.x - 22;
    sim.wick.y = MILL_POS.y + 26;
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(sim.hasGear).toBe(true);
    sim.wick.x = MILL_POS.x;
    sim.wick.y = MILL_POS.y + 10;
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(sim.jammed).toBe(true);
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.25));
    expect(sim.sluiceOpen).toBe(true);
    expect(sim.secrets.has("stayed-bridge")).toBe(true);
  });

  it("locks without a jam and floods the causeway", () => {
    const sim = startSim();
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.25));
    expect(sim.sluiceOpen).toBe(false);
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.6));
    expect(sim.causewayOpen).toBe(false);
  });

  it("reveals the flare freq at the argument and intercepts at the mast", () => {
    const sim = startSim();
    sim.wick.x = LIGHTHOUSE_POS.x;
    sim.wick.y = LIGHTHOUSE_POS.y + 30;
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.52));
    expect(sim.freqKnown).toBe(true);
    // Tune to 88.
    sim.wick.x = RADIO_POS.x;
    sim.wick.y = RADIO_POS.y + 10;
    sim.step();
    sim.freq = sim.flareFreq;
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.1));
    expect(sim.flareActive).toBe(true);
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(sim.intercepted).toBe(true);
    expect(sim.secrets.has("missed-ferry")).toBe(true);
  });

  it("witnesses the crate move and reports it at the hut", () => {
    const sim = startSim();
    sim.wick.x = DOCK_POS.x;
    sim.wick.y = DOCK_POS.y;
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.46));
    expect(sim.crateAtDock).toBe(false);
    expect(sim.witnessedMove).toBe(true);
    const hut = (sim as any).findNearby ?? null;
    void hut;
    sim.wick.x = HUT_POS.x;
    sim.wick.y = HUT_POS.y;
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(sim.secrets.has("moved-crate")).toBe(true);
  });

  it("holds the beacon through the squall and opens the ebb chest", () => {
    const sim = startSim();
    // Jam first so the ebb causeway can open.
    sim.hasGear = true;
    sim.wick.x = MILL_POS.x;
    sim.wick.y = MILL_POS.y + 8;
    sim.step();
    sim.interact();
    for (let i = 0; i < 3; i++) {
      sim.wick.x = LIGHTHOUSE_POS.x;
      sim.wick.y = LIGHTHOUSE_POS.y + 10;
      sim.step();
      sim.interact();
    }
    expect(sim.lampCrank).toBe(3);
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.6));
    expect(sim.beaconHeld).toBe(true);
    expect(sim.secrets.has("lit-beacon")).toBe(true);
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.25));
    expect(sim.phase).toBe("ebb");
    expect(sim.causewayOpen).toBe(true);
    sim.wick.x = CHEST_POS.x;
    sim.wick.y = CHEST_POS.y;
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(sim.chestOpened).toBe(true);
  });

  it("awakens the vault with 3 shards and 2 secrets", () => {
    const sim = startSim();
    sim.shards = 3;
    sim.secrets.add("stayed-bridge");
    sim.secrets.add("lit-beacon");
    sim.wick.x = VAULT_POS.x;
    sim.wick.y = VAULT_POS.y + 8;
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(sim.vaultLit).toBe(true);
    expect(sim.secrets.has("tideglass")).toBe(true);
  });

  it("wins the descent at the vault and dismisses the panel", () => {
    const sim = startSim();
    sim.shards = 3;
    sim.secrets.add("stayed-bridge");
    sim.secrets.add("lit-beacon");
    sim.wick.x = VAULT_POS.x;
    sim.wick.y = VAULT_POS.y + 8;
    sim.step();
    expect(sim.interact()).toBe(true);
    expect(sim.won).toBe(true);
    expect(sim.showWin).toBe(true);
    expect(sim.events).toContain("win");
    sim.down(10, 10);
    expect(sim.showWin).toBe(false);
    expect(sim.vaultLit).toBe(true);
  });

  it("deals the island from the workspace seed", () => {
    const opts = { width: 220, height: 320, hud: NO_HUD, inputMode: "pointer" as const, projects: DEMO_ARCADE_PROJECTS };
    const a = new TideglassSim(opts);
    const b = new TideglassSim(opts);
    // Same workspace: same seed, same culprit, same frequency, same wash-ups, same crew.
    expect(a.seed).toBe(b.seed);
    expect(a.flareFreq).toBe(b.flareFreq);
    expect(a.culprit).toBe(b.culprit);
    expect(a.pickups.map((p) => [p.x, p.y])).toEqual(b.pickups.map((p) => [p.x, p.y]));
    expect(a.npcs.map((n) => n.accent)).toEqual(b.npcs.map((n) => n.accent));
    // Different workspace: different seed, and the manifest names its own work.
    const alt: ArcadeProject[] = [
      { id: "x", name: "X MARKS", accent: "#ff0000", biome: "tropic", tasks: [{ title: "OTHER", priority: "low", dueMin: 10, overdue: false }], notes: [] },
    ];
    expect(seedFromWorkspace(alt)).not.toBe(seedFromWorkspace(DEMO_ARCADE_PROJECTS));
    const c = new TideglassSim({ ...opts, projects: alt });
    expect(c.seed).toBe(seedFromWorkspace(alt));
    expect(c.flareFreq).toBeGreaterThanOrEqual(0);
    expect(c.flareFreq).toBeLessThan(4);
    expect(c.culprit).toBeGreaterThanOrEqual(0);
    expect(c.culprit).toBeLessThan(4);
    expect(c.manifestTask()).toBe("OTHER");
    expect(c.npcs[0].accent).toBe("#ff0000");
  });

  it("tracks a full tap-walk down the fall line", () => {
    const sim = startSim();
    sim.wick.x = 540;
    sim.wick.y = 200;
    sim.step();
    sim.walkPath = sim.findPath(540, 200, 540, 1180);
    expect(sim.walkPath.length).toBeGreaterThan(0);
    const onScreen = (): boolean => {
      const p = project(sim.wick.x, sim.wick.y, heightAt(sim.wick.x, sim.wick.y));
      return p.vx >= sim.camVX && p.vx <= sim.camVX + sim.W && p.vy >= sim.camVY && p.vy <= sim.camVY + sim.H;
    };
    for (let i = 0; i < 1500 && sim.walkPath.length; i++) {
      sim.step();
      expect(onScreen()).toBe(true);
    }
    // Stops at the shore: the causeway to the flats is under water until ebb.
    expect(sim.walkPath.length).toBe(0);
    expect(isSea(sim.wick.x, sim.wick.y)).toBe(false);
    expect(Math.hypot(sim.wick.x - 540, sim.wick.y - 1180)).toBeGreaterThan(80);

    // At ebb (with the sluice jammed open) the stones are bare and the walk reaches the flats.
    sim.jammed = true;
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.85));
    sim.walkPath = sim.findPath(sim.wick.x, sim.wick.y, 540, 1180);
    for (let i = 0; i < 1500 && sim.walkPath.length; i++) sim.step();
    expect(Math.hypot(sim.wick.x - 540, sim.wick.y - 1180)).toBeLessThan(40);
  });

  it("keeps the Wick out of the open sea", () => {
    const sim = startSim();
    sim.wick.x = 600;
    sim.wick.y = 985;
    expect(sim.canStep(600, 985, 1040, 1300)).toBe(false);
    expect(sim.canStep(640, 1010, 650, 1020)).toBe(!isSea(650, 1020));
  });

  it("keeps the wick on screen everywhere on the map", () => {
    const sim = startSim();
    const spots: [number, number][] = [
      [540, 170], [240, 420], [840, 420], [540, 640], [220, 900],
      [850, 1030], [540, 1180], [60, 60], [1020, 1260], [1020, 100], [60, 1260],
    ];
    for (const [x, y] of spots) {
      sim.wick.x = x;
      sim.wick.y = y;
      sim.step();
      const p = project(x, y, heightAt(x, y));
      expect(p.vx).toBeGreaterThanOrEqual(sim.camVX);
      expect(p.vx).toBeLessThanOrEqual(sim.camVX + sim.W);
      expect(p.vy).toBeGreaterThanOrEqual(sim.camVY);
      expect(p.vy).toBeLessThanOrEqual(sim.camVY + sim.H);
    }
  });

  it("frames the summit vista: lighthouse and trailhead on screen", () => {
    for (const [W, H] of [[220, 320], [180, 320], [520, 320]] as const) {
      const sim = new TideglassSim({ width: W, height: H, hud: NO_HUD, inputMode: "pointer", projects: DEMO_ARCADE_PROJECTS });
      sim.down(W / 2, H / 2);
      for (const [x, y] of [[LIGHTHOUSE_POS.x, LIGHTHOUSE_POS.y], [SUMMIT_START.x, SUMMIT_START.y], [TRAIL[1].x, TRAIL[1].y]] as const) {
        const p = project(x, y, heightAt(x, y));
        // Sprites have width; allow a few px of bleed at the frame edge.
        expect(p.vx).toBeGreaterThanOrEqual(sim.camVX - 4);
        expect(p.vx).toBeLessThanOrEqual(sim.camVX + W + 4);
        expect(p.vy).toBeGreaterThanOrEqual(sim.camVY - 4);
        expect(p.vy).toBeLessThanOrEqual(sim.camVY + H + 4);
      }
    }
  });

  it("renders title, play, squall, ebb and log without errors", () => {
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
    const sim = new TideglassSim({ width: 180, height: 320, hud: { ...NO_HUD, top: 8 }, projects: DEMO_ARCADE_PROJECTS });
    const renderer = new TideglassRenderer(noopBackend, sim);
    expect(renderer.draw()).toBe(1);
    sim.down(90, 160);
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.6));
    sim.step();
    expect(renderer.draw()).toBe(2);
    sim.advanceClock(Math.round(CYCLE_FRAMES * 0.25));
    sim.step();
    expect(renderer.draw()).toBe(3);
    sim.showLog = true;
    expect(renderer.draw()).toBe(4);
    renderer.resize(520, 320);
    expect(renderer.draw()).toBe(5);
  });
});
