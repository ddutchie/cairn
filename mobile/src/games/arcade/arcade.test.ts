import { describe, expect, it } from "vitest";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import { ArcadeMenu } from "@cairn/shared/arcade/menu";

describe("arcade menu", () => {
  it("paginates cartridges inside the playfield, clear of the rail", () => {
    const m = new ArcadeMenu({ width: 240, height: 320, hud: { ...NO_HUD, top: 5, right: 30 }, bests: { wayfinder: 12 } });
    expect(m.pageCount).toBe(3);
    expect(m.cards.map((c) => c.id)).toEqual(["office", "task-force", "wayfinder", "inbox-zero"]);
    for (const c of m.cards) {
      expect(c.x + c.w).toBeLessThanOrEqual(240 - 30);
      expect(c.y + c.h).toBeLessThanOrEqual(320);
    }
    expect(m.cards[2].best).toBe(12);
    expect(m.titleY).toBeGreaterThan(5);

    m.setPage(1);
    expect(m.cards.map((c) => c.id)).toEqual(["stacker", "breakout", "basecamp", "tideglass"]);

    // Asymmetric bottom inset: last card and footer stay clear of hud.bottom = 60.
    const mBot = new ArcadeMenu({ width: 220, height: 320, hud: { ...NO_HUD, bottom: 60 } });
    const last = mBot.cards[mBot.cards.length - 1];
    expect(last.y + last.h).toBeLessThanOrEqual(320 - 60);
    expect(mBot.pageY).toBeLessThanOrEqual(320 - 60);
  });

  it("opens the tapped game after its blink, and only once", () => {
    const m = new ArcadeMenu({ width: 180, height: 320 });
    m.setPage(1);
    const c = m.cards[0];
    m.down(0, 0);
    expect(m.chosen).toBeNull();
    m.down(c.x + 5, c.y + 5);
    m.down(m.cards[1].x + 5, m.cards[1].y + 5);
    expect(m.chosen).toBe(0);
    for (let i = 0; i < 30; i++) m.step();
    expect(m.events).toEqual(["page", "select", "open:stacker"]);
  });
});
