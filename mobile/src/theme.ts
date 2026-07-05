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

/** Returns the theme for the current system colour scheme. */
export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === "light" ? lightTheme : darkTheme;
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
