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

/** Priority colours (match desktop analyticsUtils PRIORITY_COLOR). */
export const PRIORITY_COLOR: Record<string, string> = {
  low: "#94a3b8",
  medium: "#6366f1",
  high: "#f59e0b",
  urgent: "#ef4444",
};

/** Returns the theme for the current system colour scheme. */
export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === "light" ? lightTheme : darkTheme;
}
