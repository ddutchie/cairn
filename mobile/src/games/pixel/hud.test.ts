import { describe, expect, it } from "vitest";
import { HUD_PAD, NO_HUD, hudFrame } from "@cairn/shared/arcade/pixel/hud";
import { cornerSafeInsets } from "../../lib/screen-corners";
import { hudFromInsets } from "./hud";

describe("hudFrame", () => {
  it("is a plain margin with no insets (desktop)", () => {
    const f = hudFrame(NO_HUD, 300, 200);
    expect(f.top).toEqual({ y: HUD_PAD, lx: HUD_PAD, rx: 300 - HUD_PAD, cx: 150 });
    expect(f.bottom.y).toBe(200 - HUD_PAD);
    expect(f.content.lx).toBe(HUD_PAD);
  });

  it("keeps the edge rows clear of the unfolded Duo's corners and the side rail", () => {
    // Unfolded Duo: no top inset (the status pill lives in the rail), a right-hand rail, scale 2.
    const hud = hudFromInsets(cornerSafeInsets({ top: 0, right: 64, bottom: 20, left: 0 }, { maxBottom: 12 }), 2);
    const f = hudFrame(hud, 480, 380);
    expect(hud.top).toBeLessThan(8);
    // The top row sits in the corner curve's band, so it moves in further than the plain side inset.
    expect(f.top.lx).toBeGreaterThan(f.content.lx);
    expect(f.top.lx).toBeGreaterThanOrEqual(hud.topLeft);
    expect(f.top.rx).toBeLessThanOrEqual(480 - hud.topRight);
    expect(f.bottom.lx).toBeGreaterThanOrEqual(hud.bottomLeft);
    expect(f.content.rx).toBeLessThanOrEqual(480 - hud.right);
    expect(f.top.y).toBeGreaterThanOrEqual(hud.top);
    expect(f.bottom.y).toBeLessThanOrEqual(380 - hud.bottom);
  });
});
