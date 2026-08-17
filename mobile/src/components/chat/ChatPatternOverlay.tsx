import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Rect, Line, Circle, Defs, Pattern } from "react-native-svg";
import type { ChatPattern } from "@cairn/shared/ui/chat-themes";

/**
 * Renders a chat-theme background pattern (scanlines / dots / grid / crosshatch /
 * diagonal / noise) as an absolutely-positioned overlay over the theme's base
 * background colour. Pure data-driven — the pattern id comes from the theme JSON,
 * the app draws it with react-native-svg (no image assets, nothing to fetch).
 *
 * The overlay is drawn in a low-alpha white so it reads as a texture on dark and
 * light backgrounds alike without needing a per-mode colour in the theme JSON.
 */
export function ChatPatternOverlay({ pattern }: { pattern: ChatPattern }) {
  const id = "cairn-chat-pattern";

  // Deterministic pseudo-noise: a fixed set of tiny specks at seeded positions
  // (mulberry32 seeded by the pattern id) so the same theme renders identically
  // every time — no Math.random on the render path. The PRNG state is held
  // OUTSIDE the closure so it advances between calls (a fresh seed per call
  // would emit the same value every time and stack every speck in one spot).
  const noiseSpecks = useMemo(() => {
    const seed = 0x5eed ^ [...pattern].reduce((a, c) => a + c.charCodeAt(0), 0);
    let state = seed;
    const rnd = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const specks: { x: number; y: number; r: number; o: number }[] = [];
    for (let i = 0; i < 90; i++) {
      specks.push({
        x: (rnd() * 96) % 96,
        y: (rnd() * 96) % 96,
        r: 0.4 + rnd() * 0.8,
        o: 0.25 + rnd() * 0.5,
      });
    }
    return specks;
  }, [pattern]);

  if (pattern === "none") return null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          {pattern === "scanlines" && (
            <Pattern id={id} width={4} height={4} patternUnits="userSpaceOnUse">
              <Line x1={0} y1={0.5} x2={4} y2={0.5} stroke="#ffffff" strokeOpacity={0.06} strokeWidth={1} />
            </Pattern>
          )}
          {pattern === "dots" && (
            <Pattern id={id} width={8} height={8} patternUnits="userSpaceOnUse">
              <Circle cx={1.5} cy={1.5} r={0.9} fill="#ffffff" fillOpacity={0.08} />
            </Pattern>
          )}
          {pattern === "grid" && (
            <Pattern id={id} width={16} height={16} patternUnits="userSpaceOnUse">
              <Line x1={0} y1={0.5} x2={16} y2={0.5} stroke="#ffffff" strokeOpacity={0.05} strokeWidth={1} />
              <Line x1={0.5} y1={0} x2={0.5} y2={16} stroke="#ffffff" strokeOpacity={0.05} strokeWidth={1} />
            </Pattern>
          )}
          {pattern === "crosshatch" && (
            <Pattern id={id} width={8} height={8} patternUnits="userSpaceOnUse">
              <Line x1={0} y1={0} x2={8} y2={8} stroke="#ffffff" strokeOpacity={0.05} strokeWidth={1} />
              <Line x1={8} y1={0} x2={0} y2={8} stroke="#ffffff" strokeOpacity={0.05} strokeWidth={1} />
            </Pattern>
          )}
          {pattern === "diagonal" && (
            <Pattern id={id} width={8} height={8} patternUnits="userSpaceOnUse">
              <Line x1={0} y1={0} x2={8} y2={8} stroke="#ffffff" strokeOpacity={0.05} strokeWidth={1} />
            </Pattern>
          )}
          {pattern === "noise" && (
            <Pattern id={id} width={96} height={96} patternUnits="userSpaceOnUse">
              {noiseSpecks.map((s, i) => (
                <Circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#ffffff" fillOpacity={s.o * 0.14} />
              ))}
            </Pattern>
          )}
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}