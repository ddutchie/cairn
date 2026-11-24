import { describe, expect, it } from "vitest";
import { DEMO_ARCADE_PROJECTS } from "@cairn/shared/arcade/pixel/arcade-data";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import { KO_PENALTY, MAX_HP, RETREAT_PENALTY, applyRelic, dealDeck, exploreLayout, freshVoyage, goldFor, isFight, kindAt, landRect, type StepKind } from "@cairn/shared/arcade/wayfinder/expedition";
import { WD, WayfinderSim, type Isle } from "@cairn/shared/arcade/wayfinder/sim";

describe("WayfinderSim", () => {
  it("builds harbours, note islands, crates, and overdue storms from workspace projects", () => {
    const sim = new WayfinderSim({ width: 200, height: 360, projects: DEMO_ARCADE_PROJECTS });
    expect(sim.harbours.length).toBeGreaterThanOrEqual(4);
    expect(sim.islands.length).toBeGreaterThanOrEqual(10);
    expect(sim.allCrates.length).toBeGreaterThan(0);
    expect(sim.stormTasks.length).toBeGreaterThan(0);
    expect(sim.worldPixels.length).toBe(WD * 900 * 4);
  });

  it("steers on drag, clears steering on finger lift, and toggles the map", () => {
    const sim = new WayfinderSim({ width: 220, height: 380, projects: DEMO_ARCADE_PROJECTS, hud: { ...NO_HUD, top: 10 } });
    // Start sailing
    sim.down(110, 200);
    expect(sim.state).toBe("sail");
    expect(sim.events).toContain("start");

    // Drag to steer, then lift finger
    sim.down(160, 140);
    expect(sim.steer).toEqual({ x: 160, y: 140 });
    sim.move(170, 130);
    expect(sim.steer).toEqual({ x: 170, y: 130 });
    sim.step();
    expect(sim.boat.v).toBeGreaterThan(0);
    sim.up();
    expect(sim.steer).toBeNull();

    // Tap map button (top-left under hud.top)
    sim.down(12, 20);
    expect(sim.state).toBe("map");
    // Tap again to close map
    sim.down(110, 200);
    expect(sim.state).toBe("sail");
  });

  it("loads crates at Today and centers camX on wide unfolded screens", () => {
    const sim = new WayfinderSim({ width: 700, height: 320, projects: DEMO_ARCADE_PROJECTS });
    sim.down(100, 100);
    for (let i = 0; i < 10; i++) sim.step();
    expect(sim.camX).toBe(Math.round((WD - 700) / 2));
    // Boat starts near Today lighthouse so crates load immediately
    expect(sim.boat.cargo.length).toBeGreaterThan(0);
    expect(sim.events).toContain("load");
  });

  it("bobs gently in place on the title screen with fishing and swimming crew", () => {
    const sim = new WayfinderSim({ width: 220, height: 380, projects: DEMO_ARCADE_PROJECTS });
    const startX = sim.boat.x;
    const startY = sim.boat.y;
    for (let i = 0; i < 240; i++) sim.step();
    expect(sim.boat.x).toBe(startX);
    expect(sim.boat.y).toBe(startY);
    expect(Math.abs(sim.boat.a)).toBeLessThanOrEqual(0.15);
    expect(sim.crew.cast).toBeGreaterThan(0);
    expect(sim.crew.swim).toBe("swim");
    expect(sim.score).toBe(0);
    expect(sim.events).toEqual([]);
  });
});

describe("Wayfinder fog dirty tracking", () => {
  it("reports only the fog cells a reveal changed, once", () => {
    const sim = new WayfinderSim({ width: 180, height: 320, projects: DEMO_ARCADE_PROJECTS });
    sim.takeFogDirty();
    expect(sim.takeFogDirty()).toBeNull();
    sim.reveal(400, 300, 24);
    const d = sim.takeFogDirty()!;
    expect(d[0]).toBeLessThanOrEqual(50);
    expect(d[2]).toBeGreaterThanOrEqual(49);
    expect(d[2] - d[0]).toBeLessThanOrEqual(7);
    expect(sim.takeFogDirty()).toBeNull();
    sim.reveal(400, 300, 24);
    expect(sim.takeFogDirty()).toBeNull();
  });
});

describe("Wayfinder island expeditions", () => {
  const probe = new WayfinderSim({ width: 180, height: 320, projects: DEMO_ARCADE_PROJECTS });
  probe.setKey("Space", true);
  const sim0Crates = (o: Isle) => probe.crates.some((c) => c.p.id === o.p?.id);
  const sim0Storms = (o: Isle) => probe.storms.some((st) => st.p.id === o.p?.id);
  const start = (width = 180, height = 320, hud = NO_HUD) => {
    const sim = new WayfinderSim({ width, height, hud, inputMode: width > 200 ? "pointer" : "touch", projects: DEMO_ARCADE_PROJECTS });
    sim.setKey("Space", true);
    expect(sim.state).toBe("sail");
    return sim;
  };
  /** Park the boat in open water just off an island and let one frame pass. */
  const anchorBeside = (sim: WayfinderSim, pick = (is: Isle) => !is.explored) => {
    for (const is of sim.islands.filter(pick)) {
      for (let a = 0; a < Math.PI * 2; a += 0.2) {
        for (let d = is.r * 0.9; d < is.r * 1.4 + 10; d += 1) {
          const x = is.x + Math.cos(a) * d, y = is.y + Math.sin(a) * d;
          if (x < 8 || y < 8 || x > WD - 8 || y > 892) continue;
          if (sim.E[(y | 0) * WD + (x | 0)] > 0.02) continue;
          const near = sim.islands.filter((o) => !o.explored && Math.hypot(o.x - x, o.y - y) < o.r * 1.4 + 12);
          if (near.length !== 1 || near[0] !== is) continue;
          Object.assign(sim.boat, { x, y, v: 0 });
          sim.step();
          if (sim.nearIsland === is) return is;
        }
      }
    }
    throw new Error("no anchorage found");
  };
  const settle = (sim: WayfinderSim) => {
    for (let i = 0; i < 12; i++) sim.step();
  };
  const ashore = (width?: number, height?: number, hud?: typeof NO_HUD, middle?: StepKind[], pick?: (is: Isle) => boolean) => {
    const sim = start(width, height, hud);
    const is = anchorBeside(sim, pick);
    sim.setKey("KeyE", true);
    expect(sim.state).toBe("explore");
    settle(sim);
    const exp = sim.exp!;
    // Fix the deck so a test walks known encounters.
    if (middle) exp.deck = ["shore", ...middle, "shrine"];
    if (middle?.includes("fork") && !exp.routes) exp.routes = [{ isle: -1, title: "THE WILD PATH", kind: "cache" }, { isle: -1, title: "THE WILD PATH", kind: "wreck" }];
    return { sim, is, exp };
  };
  /** Strike until the foe on this step falls. */
  const fight = (sim: WayfinderSim) => {
    sim.voyage.hp = 9;
    while (isFight(kindAt(sim.exp!))) {
      sim.choose("a");
      settle(sim);
    }
    sim.voyage.hp = Math.min(sim.voyage.hp, sim.voyage.maxHp);
  };

  it("offers a landing only beside an unexplored note island at low speed", () => {
    const sim = start();
    const is = anchorBeside(sim);
    expect(sim.nearIsland).toBe(is);
    sim.boat.v = 1.5;
    expect(sim.findLanding()).toBeNull();
    sim.boat.v = 0;
    sim.kraken.phase = "up";
    expect(sim.findLanding()).toBeNull();
    sim.kraken.phase = "none";
    Object.assign(sim.boat, { x: sim.today.x, y: sim.today.y + 22 });
    expect(sim.findLanding()).toBeNull();
  });

  it("lands by tapping the prompt, pauses the sea clock and kraken ashore, and retreats with a time penalty", () => {
    const sim = start();
    anchorBeside(sim);
    const r = landRect(sim.W, sim.H, sim.hud, sim.boat.cargo.length);
    sim.down(r.x + r.w / 2, r.y + r.h / 2);
    expect(sim.state).toBe("explore");
    expect(sim.events).toContain("dock");
    expect(sim.steer).toBeNull();
    const clock = sim.clock, score = sim.score;
    for (let i = 0; i < 600; i++) sim.step();
    expect(sim.clock).toBe(clock);
    expect(sim.kraken.phase).toBe("none");
    expect(sim.setKey("Escape", true)).toBe(true);
    expect(sim.state).toBe("sail");
    expect(sim.clock).toBe(clock + RETREAT_PENALTY);
    expect(sim.events).toContain("escape-island");
    expect(sim.score).toBe(score);
  });

  it("deals each island its own deck: shore first, shrine last, always a fight, forks only toward links", () => {
    const sim = start();
    const decks = new Set<string>();
    for (const is of sim.islands) {
      const info = sim.islandInfo(is), d = dealDeck(info);
      expect(d.deck[0]).toBe("shore");
      expect(d.deck[d.deck.length - 1]).toBe("shrine");
      expect(d.deck.some(isFight)).toBe(true);
      expect(d.deck.length).toBeGreaterThanOrEqual(4);
      expect(d.deck.length).toBeLessThanOrEqual(6);
      expect(dealDeck(info).deck).toEqual(d.deck);
      if (is.orphan) {
        expect(d.mood).toBe("lost");
        expect(d.deck).not.toContain("fork");
      }
      if (d.deck.includes("fork")) {
        expect(is.links.length).toBeGreaterThan(0);
        expect(d.routes).not.toBeNull();
        expect(is.links).toContain(d.routes![0].isle);
      }
      if (info.crate && !is.orphan) expect(d.deck).toContain("camp");
      decks.add(d.deck.join(","));
    }
    expect(decks.size).toBeGreaterThanOrEqual(4);
  });

  it("clears an island with option A, then banks treasure, relics and the chart", () => {
    const { sim, is, exp } = ashore(undefined, undefined, undefined, ["ambush", "cache"]);
    expect(kindAt(exp)).toBe("shore");
    expect(sim.choose("a")).toBe(true);
    expect(exp.scouted).toBe(true);
    settle(sim);
    expect(kindAt(exp)).toBe("ambush");
    expect(exp.foeMax).toBe(Math.max(1, 3 + (exp.rich >= 1.6 ? 1 : 0) - 1));
    fight(sim);
    expect(sim.events).toContain("attack");
    expect(kindAt(exp)).toBe("cache");
    sim.choose("a");
    settle(sim);
    expect(exp.relics.length).toBe(1);
    expect(kindAt(exp)).toBe("shrine");
    sim.choose("a");
    expect(exp.phase).toBe("summary");
    const gold = exp.gold, score = sim.score;
    sim.setKey("Enter", true);
    expect(sim.state).toBe("sail");
    expect(is.explored).toBe(true);
    expect(is.charted).toBe(true);
    expect(sim.score).toBe(score + gold + (is.orphan ? 60 : 30));
    expect(sim.voyage.fog).toBe(is.orphan ? 24 : 12);
    expect(sim.voyage.speed).toBeCloseTo(0.08);
    expect(sim.findLanding()).not.toBe(is);
  });

  it("takes option B: beach gold, bait, patch up, and the shrine offering", () => {
    const { sim, exp } = ashore(undefined, undefined, undefined, ["ambush", "cache"]);
    sim.voyage.hp = 2;
    sim.choose("b");
    expect(exp.gold).toBeGreaterThanOrEqual(8);
    settle(sim);
    const sup = sim.voyage.supplies;
    sim.choose("b");
    expect(sim.voyage.supplies).toBe(sup - 1);
    settle(sim);
    expect(kindAt(exp)).toBe("cache");
    sim.choose("b");
    expect(sim.voyage.hp).toBe(3);
    expect(sim.voyage.supplies).toBe(sup);
    settle(sim);
    exp.gold = 12;
    sim.choose("b");
    expect(exp.gold).toBe(2);
    expect(exp.relics).toContain("BLESSED HOLD");
    sim.down(0, 0);
    expect(sim.holdSize).toBe(4);
  });

  it("refuses the shrine offering and the hermit's trade without gold, and ignores double taps", () => {
    const { sim, exp } = ashore(undefined, undefined, undefined, ["hermit"]);
    expect(sim.choose("a")).toBe(true);
    expect(sim.choose("a")).toBe(false);
    settle(sim);
    exp.gold = 0;
    expect(kindAt(exp)).toBe("hermit");
    expect(sim.choose("a")).toBe(false);
    expect(sim.choose("b")).toBe(true);
    settle(sim);
    expect(kindAt(exp)).toBe("shrine");
    expect(sim.choose("b")).toBe(false);
    expect(exp.phase).toBe("step");
  });

  it("knocks the captain out on the last heart and washes them aboard with 1 heart", () => {
    const { sim, is, exp } = ashore(undefined, undefined, undefined, ["ambush"]);
    sim.choose("b");
    settle(sim);
    sim.voyage.hp = 1;
    sim.voyage.supplies = 0;
    const clock = sim.clock, score = sim.score;
    sim.choose("b");
    expect(sim.events).toContain("hurt");
    expect(exp.phase).toBe("ko");
    while (sim.state === "explore") sim.step();
    expect(sim.state).toBe("sail");
    expect(sim.voyage.hp).toBe(1);
    expect(sim.clock).toBe(clock + KO_PENALTY);
    expect(sim.score).toBe(score);
    expect(is.explored).toBe(false);
  });

  it("the foe hits back on every other strike", () => {
    const { sim, exp } = ashore(undefined, undefined, undefined, ["ambush", "cache"]);
    sim.choose("b");
    settle(sim);
    exp.foeHp = exp.foeMax = 3;
    sim.choose("a");
    expect(sim.voyage.hp).toBe(2);
    settle(sim);
    sim.choose("a");
    expect(sim.voyage.hp).toBe(2);
    settle(sim);
    sim.choose("a");
    expect(kindAt(exp)).toBe("cache");
  });

  it("follows a fork toward a linked note and charts that island on banking", () => {
    const { sim, is, exp } = ashore(undefined, undefined, undefined, ["fork", "ambush"], (o) => !o.explored && o.links.length > 0);
    const target = sim.islands[is.links[0]];
    exp.routes = [{ isle: target.i, title: target.title, kind: "wreck" }, { isle: -1, title: "THE WILD PATH", kind: "den" }];
    target.charted = false;
    sim.choose("b");
    settle(sim);
    expect(kindAt(exp)).toBe("fork");
    sim.choose("a");
    settle(sim);
    expect(kindAt(exp)).toBe("wreck");
    expect(exp.deck).toEqual(["shore", "fork", "wreck", "ambush", "shrine"]);
    sim.choose("b");
    settle(sim);
    fight(sim);
    sim.choose("a");
    sim.setKey("Enter", true);
    expect(target.charted).toBe(true);
  });

  it("loads a project task crate at a camp and carries it to sea on banking", () => {
    const { sim, is, exp } = ashore(undefined, undefined, undefined, ["camp", "ambush"], (o) => !o.explored && !o.orphan && sim0Crates(o));
    expect(exp.crate).not.toBeNull();
    sim.boat.cargo = [];
    sim.choose("b");
    settle(sim);
    expect(kindAt(exp)).toBe("camp");
    sim.choose("a");
    expect(exp.crateTaken).toBe(true);
    settle(sim);
    fight(sim);
    sim.choose("a");
    const before = sim.crates.length;
    sim.setKey("Enter", true);
    expect(sim.boat.cargo.map((c) => c.title)).toContain(exp.crate!.title);
    expect(sim.boat.cargo[0].p).toBe(is.p);
    expect(sim.crates.length).toBe(before - 1);
  });

  it("beats an overdue task's foe for a storm glass and shrinks its storm", () => {
    const { sim, is, exp } = ashore(undefined, undefined, undefined, ["overdue"], (o) => !o.explored && !o.orphan && sim0Storms(o));
    const storm = sim.storms.find((st) => st.p === is.p)!;
    const r = storm.r;
    expect(exp.overdue).toBe(storm.title);
    sim.choose("b");
    settle(sim);
    expect(kindAt(exp)).toBe("overdue");
    fight(sim);
    expect(exp.calmed).toBe(true);
    expect(exp.relics).toContain("STORM GLASS");
    sim.choose("a");
    sim.setKey("Enter", true);
    expect(storm.r).toBeLessThan(r);
    expect(sim.voyage.storm).toBeCloseTo(0.2);
  });

  it("a scouted trap is safe; an unscouted one costs a supply or a heart", () => {
    const a = ashore(undefined, undefined, undefined, ["trap"]);
    a.sim.choose("a");
    settle(a.sim);
    const sup = a.sim.voyage.supplies, hp = a.sim.voyage.hp;
    a.sim.choose("b");
    expect(a.sim.voyage.hp).toBe(hp);
    expect(a.sim.voyage.supplies).toBe(sup);
    const b = ashore(undefined, undefined, undefined, ["trap"]);
    b.sim.choose("b");
    settle(b.sim);
    const hp2 = b.sim.voyage.hp;
    b.sim.choose("b");
    expect(b.sim.voyage.hp).toBe(hp2 - 1);
  });

  it("new relics: iron heart, lucky coin, storm glass, kraken tooth", () => {
    const v = freshVoyage();
    applyRelic(v, "IRON HEART");
    expect(v.maxHp).toBe(MAX_HP + 1);
    expect(v.hp).toBe(MAX_HP + 1);
    applyRelic(v, "IRON HEART");
    applyRelic(v, "IRON HEART");
    expect(v.maxHp).toBe(MAX_HP + 2);
    applyRelic(v, "STORM GLASS");
    applyRelic(v, "KRAKEN TOOTH");
    applyRelic(v, "LUCKY COIN");
    expect([v.storm, v.kraken, v.luck]).toEqual([0.2, 1, 1]);
    const { exp } = ashore();
    const plain = goldFor(exp, 10);
    exp.luck = 2;
    expect(goldFor(exp, 10)).toBeGreaterThan(plain);
  });

  it("hit-tests the A/B cards and SAIL inside the safe area on a phone and a wide Duo with insets", () => {
    // Unfolded Duo: a low top inset, so the top bar must also clear the rounded corners.
    const duoHud = { ...NO_HUD, top: 5, left: 30, right: 22, bottom: 16, topLeft: 36, topRight: 34, bottomLeft: 30, bottomRight: 22 };
    for (const [w, h, hud] of [[180, 320, NO_HUD], [420, 380, duoHud]] as const) {
      const { sim, exp } = ashore(w, h, hud, ["ambush"]);
      const L = exploreLayout(w, h, hud);
      for (const r of [L.a, L.b, L.sail, L.card]) {
        expect(r.x).toBeGreaterThanOrEqual(hud.left);
        expect(r.x + r.w).toBeLessThanOrEqual(w - hud.right);
        expect(r.y).toBeGreaterThanOrEqual(hud.top);
      }
      expect(L.captainY).toBeLessThanOrEqual(h - hud.bottom);
      expect(L.barLx).toBeGreaterThanOrEqual(hud.topLeft);
      expect(L.sail.x + L.sail.w).toBeLessThanOrEqual(w - hud.topRight);
      sim.down(L.b.x + 2, L.b.y + 2);
      expect(exp.step).toBe(1);
      settle(sim);
      sim.down(L.a.x + L.a.w - 2, L.a.y + L.a.h - 2);
      expect(sim.events).toContain("attack");
      settle(sim);
      sim.down(L.sail.x + 3, L.sail.y + 3);
      expect(sim.state).toBe("sail");
    }
  });

  it("drives choices from the keyboard and keeps the layout centred across a live resize", () => {
    const { sim, exp } = ashore(400, 320, undefined, ["ambush"]);
    expect(sim.setKey("ArrowRight", true)).toBe(true);
    expect(exp.sel).toBe(1);
    sim.setKey("Enter", true);
    expect(exp.step).toBe(1);
    settle(sim);
    sim.setKey("Digit1", true);
    expect(sim.events).toContain("attack");
    settle(sim);
    sim.resize(720, 320);
    const L = exploreLayout(sim.W, sim.H, sim.hud);
    expect(L.cx).toBe(360);
    expect(L.card.x + L.card.w / 2).toBeCloseTo(360, 0);
    expect(sim.state).toBe("explore");
    sim.setKey("ArrowRight", false);
    sim.setKey("Escape", true);
    expect(sim.state).toBe("sail");
    expect(sim.setKey("Escape", true)).toBe(false);
  });
});
