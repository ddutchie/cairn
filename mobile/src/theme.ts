/**
 * Cairn mobile theme — mirrors the desktop CSS custom properties
 * (src/app/globals.css) so the two apps share one visual language.
 *
 * Desktop uses CSS variables that flip on data-theme; RN has no cascade, so we
 * expose the same tokens as JS objects and pick one via useTheme() based on the
 * system colour scheme.
 */

import { useColorScheme } from "react-native";

export interface Theme {
  background: string;
  surface: string;
  surface2: string;
  surface3: string;
  border: string;
  borderSubtle: string;
  accent: string;
  accentHover: string;
  accentDim: string;
  accentFg: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
}

export const darkTheme: Theme = {
  background: "#0d0d0d",
  surface: "#141414",
  surface2: "#1a1a1a",
  surface3: "#222222",
  border: "#2a2a2a",
  borderSubtle: "#1f1f1f",
  accent: "#7c6af7",
  accentHover: "#9281ff",
  accentDim: "rgba(124, 106, 247, 0.15)",
  accentFg: "#16082e",
  textPrimary: "#e8e4dc",
  textSecondary: "#9e9a94",
  textTertiary: "#66635f",
  success: "#3ecf8e",
  warning: "#f59e0b",
  danger: "#ef4444",
  info: "#60a5fa",
};

export const lightTheme: Theme = {
  background: "#f5f4f1",
  surface: "#ffffff",
  surface2: "#f0eeeb",
  surface3: "#e8e5e1",
  border: "#dddad6",
  borderSubtle: "#eae7e3",
  accent: "#6457e8",
  accentHover: "#7c6af7",
  accentDim: "rgba(100, 87, 232, 0.12)",
  accentFg: "#ffffff",
  textPrimary: "#1a1917",
  textSecondary: "#4a4744",
  textTertiary: "#9e9a94",
  success: "#1a9e68",
  warning: "#d97706",
  danger: "#dc2626",
  info: "#2563eb",
};

/** Priority colours — re-exported from shared so desktop + mobile match. */
export { PRIORITY_COLOR } from "@cairn/shared/ui/constants";

/**
 * Elevation ladder — the RN analogue of the desktop shadow scale
 * (shadow-sm → shadow-xl in globals.css). Each level bundles the iOS shadow*
 * props with an Android `elevation` so cards/menus/modals read with depth
 * instead of flat 1px borders. Spread into a style object.
 *
 * Shadows are near-black with low opacity so they work on both themes; on dark
 * surfaces they read as a subtle darkening at the card's edge.
 */
export interface Elevation {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
}

export const elevation: Record<"sm" | "md" | "lg" | "xl", Elevation> = {
  sm: { shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 2, elevation: 1 },
  md: { shadowColor: "#000", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.1, shadowRadius: 6, elevation: 3 },
  lg: { shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 8 },
  xl: { shadowColor: "#000", shadowOffset: { width: 0, height: 16 }, shadowOpacity: 0.16, shadowRadius: 30, elevation: 16 },
};

/** Returns the theme for the current system colour scheme. */
export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === "light" ? lightTheme : darkTheme;
}

/** True when the current system colour scheme is dark (default when unset). */
export function useIsDark(): boolean {
  return useColorScheme() !== "light";
}

/**
 * Apply an alpha to a hex colour → rgba() string. Mirrors the desktop's
 * color-mix / `/20` alpha usage (e.g. accent border at 20%).
 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
