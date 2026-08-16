import { describe, it, expect } from "vitest";
import {
  CHAT_THEME_PRESETS,
  CHAT_THEME_PRESET_BY_ID,
  DEFAULT_CHAT_THEME_ID,
  resolveChatTheme,
  allChatThemes,
  chatThemeFontStack,
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

  it("gives every preset a font, bgType, bubbleStyle, and both palettes", () => {
    for (const p of CHAT_THEME_PRESETS) {
      expect(["sans", "serif", "mono"]).toContain(p.font);
      expect(["solid", "gradient", "pattern"]).toContain(p.bgType);
      expect(["filled", "glass", "outlined"]).toContain(p.bubbleStyle);
      expect(p.dark.bg).toBeTruthy();
      expect(p.light.bg).toBeTruthy();
      if (p.bgType === "gradient") {
        expect(p.dark.gradient).toHaveLength(2);
        expect(p.light.gradient).toHaveLength(2);
      }
    }
  });

  it("keeps the default preset byte-matching today's rendering", () => {
    const def = CHAT_THEME_PRESET_BY_ID["default"];
    expect(def.font).toBe("sans");
    expect(def.bgType).toBe("solid");
    expect(def.bubbleStyle).toBe("filled");
    expect(def.dark).toEqual({ bg: "#141414", userBubble: "#8faf6f", userBubbleFg: "#131c0b", aiBubble: "#1a1a1a" });
    expect(def.light).toEqual({ bg: "#ffffff", userBubble: "#5c7a3f", userBubbleFg: "#ffffff", aiBubble: "#f0eeeb" });
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
    const dup = { ...CHAT_THEME_PRESETS[1], id: "paper", community: true };
    const extra = { ...CHAT_THEME_PRESETS[2], id: "extra-one", community: true };
    const all = allChatThemes([dup, extra]);
    expect(all.map((p) => p.id)).toEqual(["default", "paper", "terminal", "midnight", "aurora", "extra-one"]);
    expect(all.find((p) => p.id === "paper")?.community).toBeUndefined(); // built-in wins
  });

  it("returns a system font stack for the bundled font", () => {
    expect(chatThemeFontStack(CHAT_THEME_PRESET_BY_ID["paper"])).toMatch(/Georgia|serif/);
    expect(chatThemeFontStack(CHAT_THEME_PRESET_BY_ID["terminal"])).toMatch(/monospace|Menlo|Mono/);
  });
});
