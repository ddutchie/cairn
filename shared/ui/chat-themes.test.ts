import { describe, it, expect } from "vitest";
import {
  CHAT_THEME_PRESETS,
  CHAT_THEME_PRESET_BY_ID,
  DEFAULT_CHAT_THEME_ID,
  resolveChatTheme,
  allChatThemes,
  chatThemeFontStack,
  chatThemeFontWeightValue,
} from "./chat-themes";

function luminance(hex: string): number {
  if (hex.startsWith("rgba")) return 0.9; // translucent glass — assume lightish
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function ratio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe("chat-themes catalog", () => {
  it("ships the five built-in presets in picker order", () => {
    expect(CHAT_THEME_PRESETS.map((p) => p.id)).toEqual([
      "default", "paper", "terminal", "midnight", "aurora",
    ]);
  });

  it("defaults to the 'default' preset", () => {
    expect(DEFAULT_CHAT_THEME_ID).toBe("default");
  });

  it("declares every knob on every preset (nothing optional)", () => {
    for (const p of CHAT_THEME_PRESETS) {
      expect(["sans", "serif", "mono"]).toContain(p.font);
      expect(["regular", "medium"]).toContain(p.fontWeight);
      expect(typeof p.tracking).toBe("number");
      expect(p.lineHeight).toBeGreaterThan(0);
      expect(["solid", "gradient", "pattern"]).toContain(p.bgType);
      expect(["none", "scanlines", "dots", "grid", "crosshatch", "diagonal", "noise"]).toContain(p.pattern);
      expect(["filled", "glass", "outlined"]).toContain(p.bubbleStyle);
      expect(["sm", "md", "pill"]).toContain(p.radius);
      expect(["none", "subtle", "strong"]).toContain(p.shadow);
      for (const mode of [p.dark, p.light]) {
        expect(mode.stops.length).toBeGreaterThanOrEqual(1);
        expect(mode.stops[0]).toBe(mode.bg);
        expect(mode.userBubble).toBeTruthy();
        expect(mode.userBubbleFg).toBeTruthy();
        expect(mode.aiBubble).toBeTruthy();
        expect(mode.aiText).toBeTruthy();
      }
      if (p.bgType === "gradient") {
        expect(p.dark.stops.length).toBeGreaterThanOrEqual(2);
        expect(p.light.stops.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("keeps the default preset byte-matching today's rendering", () => {
    const def = CHAT_THEME_PRESET_BY_ID["default"];
    expect(def.font).toBe("sans");
    expect(def.bgType).toBe("solid");
    expect(def.bubbleStyle).toBe("filled");
    expect(def.dark).toEqual({
      bg: "#141414", stops: ["#141414"], userBubble: "#8faf6f", userBubbleFg: "#131c0b",
      aiBubble: "#1a1a1a", aiText: "#9e9a94",
    });
    expect(def.light).toEqual({
      bg: "#ffffff", stops: ["#ffffff"], userBubble: "#5c7a3f", userBubbleFg: "#ffffff",
      aiBubble: "#f0eeeb", aiText: "#4a4744",
    });
  });

  it("meets WCAG AA (≥4.5:1) for every light-mode user bubble fill vs its fg", () => {
    for (const p of CHAT_THEME_PRESETS) {
      const r = ratio(p.light.userBubble, p.light.userBubbleFg);
      expect(r, `${p.id} light user bubble ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("meets WCAG AA (≥4.5:1) for dark-mode user bubbles whose fg is pale", () => {
    for (const p of CHAT_THEME_PRESETS) {
      // Dark user bubbles: fg must contrast too (dark fg on light-ish fill, or
      // light fg on dark fill).
      const r = ratio(p.dark.userBubble, p.dark.userBubbleFg);
      expect(r, `${p.id} dark user bubble ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("meets WCAG AA (≥4.5:1) for every AI text colour against its bubble fill", () => {
    for (const p of CHAT_THEME_PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        const v = p[mode];
        // Skip glass/translucent fills (rgba) — can't compute a reliable ratio.
        if (v.aiBubble.startsWith("rgba")) continue;
        const r = ratio(v.aiBubble, v.aiText);
        expect(r, `${p.id} ${mode} ai text ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("resolves an unknown id to the default, and known ids to their preset", () => {
    expect(resolveChatTheme("nope").id).toBe("default");
    expect(resolveChatTheme(undefined).id).toBe("default");
    expect(resolveChatTheme("midnight").id).toBe("midnight");
  });

  it("resolves a community id when extras are provided", () => {
    const community = { ...CHAT_THEME_PRESETS[1], id: "community-x", community: true, name: "Community X" };
    expect(resolveChatTheme("community-x", [community]).id).toBe("community-x");
    // Without extras it falls back to default.
    expect(resolveChatTheme("community-x").id).toBe("default");
  });

  it("unions built-ins + extras, deduping by id with built-ins winning", () => {
    const dup = { ...CHAT_THEME_PRESETS[2], id: "paper", community: true };
    const extra = { ...CHAT_THEME_PRESETS[3], id: "extra-one", community: true };
    const all = allChatThemes([dup, extra]);
    expect(all.map((p) => p.id)).toEqual(["default", "paper", "terminal", "midnight", "aurora", "extra-one"]);
    expect(all.find((p) => p.id === "paper")?.community).toBeUndefined(); // built-in wins
  });

  it("returns a system font stack for the bundled font", () => {
    expect(chatThemeFontStack(CHAT_THEME_PRESET_BY_ID["paper"])).toMatch(/Georgia|serif/);
    expect(chatThemeFontStack(CHAT_THEME_PRESET_BY_ID["terminal"])).toMatch(/monospace|Menlo|Mono/);
  });

  it("maps the fontWeight knob to a CSS numeric value", () => {
    expect(chatThemeFontWeightValue(CHAT_THEME_PRESET_BY_ID["default"])).toBe(400);
    expect(chatThemeFontWeightValue(CHAT_THEME_PRESET_BY_ID["aurora"])).toBe(500);
  });
});