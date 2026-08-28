import { Easing } from "react-native-reanimated";

/**
 * Ported from SchroederNathan/react-native-motion
 * apps/expo/components/animations/chatgpt-attachments/constants.ts
 * Every geometric number was measured frame-by-frame off the reference
 * screen recording (1290×2796 @3x → 430×932pt). Kept as-is for fidelity;
 * colours are now theme-derived where used (see Glass/Panel).
 */

/** Side gutter shared by the composer, the menu and the photo grid. */
export const GUTTER = 12;

export const COLORS = {
  background: "#000000",
  /** Composer + keyboard surface, sampled at rgb(29,29,29). */
  surface: "#1D1D1D",
  placeholder: "#777777",
  text: "#FFFFFF",
  accent: "#007AFF",
  accentGlass: "#056DE7",
  controlScrim: "rgba(0,0,0,0.31)",
  iconWell: "rgba(255,255,255,0.09)",
  material: "rgba(255,255,255,0.047)",
  materialFlat: "#1E1E1E",
} as const;

export const COMPOSER = {
  radius: 24,
  rowHeight: 48,
  rowPaddingLeft: 14,
  plusHit: 30,
  plusWell: 34,
  keyboardGap: 12,
  stripPaddingTop: 8,
  stripGap: 7,
  thumbSize: 115,
  thumbRadius: 18,
  thumbGap: 7,
  removeBadge: 17,
  removeBadgeInset: 6,
  actionSize: 30,
  plusSize: 20,
  plusSlide: 16,
  micSize: 20,
  fieldSize: 17,
} as const;

export const PLUS_CENTER_X = GUTTER + COMPOSER.rowPaddingLeft + COMPOSER.plusHit / 2;

export const COMPOSER_COLLAPSED_HEIGHT = COMPOSER.rowHeight;

export const COMPOSER_STRIP_HEIGHT = COMPOSER.stripPaddingTop + COMPOSER.thumbSize + COMPOSER.stripGap;

export const MENU = {
  width: 280,
  itemHeight: 66,
  paddingVertical: 12,
  radius: 46,
  iconWell: 42,
  iconSize: 22,
  iconInset: 24,
  labelGap: 18,
  labelSize: 19,
  centerOffset: 7,
} as const;

export const MENU_ITEMS = 3;
export const MENU_HEIGHT = MENU.itemHeight * MENU_ITEMS + MENU.paddingVertical * 2;

export const GRID = {
  columns: 3,
  gap: 1.5,
  cellRadius: 2,
  panelRadius: 52,
  badgeSize: 23,
  badgeRing: 2,
  badgeInset: 4,
  badgeLabelSize: 14,
  pageSize: 180,
} as const;

export const BOTTOM_BAR = {
  inset: 25,
  backSize: 46,
  backIcon: 22,
  pillHeight: 43,
  pillPaddingHorizontal: 22,
  pillLabelSize: 17,
} as const;

export const CAMERA = {
  shutterSize: 68,
  shutterPadding: 4,
  optionSize: 46,
  optionIcon: 22,
  optionGap: 10,
  optionStartScale: 0.35,
  quality: 0.85,
} as const;

export const EASE_FADE = Easing.out(Easing.quad);
export const EASE_OUT = Easing.out(Easing.poly(4));

export const SPRING = {
  panel: { duration: 400, dampingRatio: 0.8 },
  panelOut: { duration: 400, dampingRatio: 1 },
  attach: { duration: 400 },
  strip: { duration: 400 },
  badge: { duration: 400 },
  pill: { duration: 400 },
} as const;

export const DURATION = {
  panel: SPRING.panel.duration,
  attach: 340,
  crossfade: 150,
  blur: 160,
  pill: 160,
  plusLead: 30,
} as const;

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function mix(t: number, a: number, b: number) {
  "worklet";
  return a + (b - a) * t;
}
