import { describe, expect, it } from "vitest";
import { NO_HUD } from "@/games/pixel/hud";
import { ArcadeMenu } from "./menu";

describe("arcade menu", () => {
  it("lays the cartridges out inside the playfield, clear of the rail", () => {
    const m = new ArcadeMenu({ width: 240, height: 320, hud: { ...NO_HUD, top: 5, right: 30 }, bests: { stacker: 12 } });
    expect(m.cards.map((c) => c.id)).toEqual(["task-force", "stacker", "breakout"]);
    for (const c of m.cards) {
      expect(c.x + c.w).toBeLessThanOrEqual(240 - 30);
      expect(c.y + c.h).toBeLessThanOrEqual(320);
    }
    expect(m.cards[1].best).toBe(12);
    expect(m.titleY).toBeGreaterThan(5);
  });

  it("opens the tapped game after its blink, and only once", () => {
    const m = new ArcadeMenu({ width: 180, height: 320 });
    const c = m.cards[2];
    m.down(0, 0);
    expect(m.chosen).toBeNull();
    m.down(c.x + 5, c.y + 5);
    m.down(m.cards[0].x + 5, m.cards[0].y + 5);
    expect(m.chosen).toBe(2);
    for (let i = 0; i < 30; i++) m.step();
    expect(m.events).toEqual(["select", "open:breakout"]);
  });
});
