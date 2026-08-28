/**
 * Cairn — Theme surface helpers (main process)
 *
 * Single source of truth for the stored theme's surface/background colours.
 * Used as BrowserWindow.backgroundColor and titleBarOverlay.color so the
 * native chrome matches the rendered TitleBar (bg-[var(--surface)]).
 *
 * Values must match globals.css:
 *  - dark  --surface #141414, --background #0d0d0d
 *  - light --surface #ffffff, --background #f5f4f1
 */

import { app } from "electron";
import fs from "fs";
import path from "path";

function readStoredTheme(): "light" | "dark" | null {
  try {
    const themeFile = path.join(app.getPath("userData"), "theme.json");
    if (!fs.existsSync(themeFile)) return null;
    const t = JSON.parse(fs.readFileSync(themeFile, "utf8")).theme;
    if (t === "light" || t === "dark") return t;
    return null;
  } catch {
    return null;
  }
}

export function getStoredThemeSurface(): string {
  return readStoredTheme() === "light" ? "#ffffff" : "#141414";
}

export function getStoredThemeBackground(): string {
  return readStoredTheme() === "light" ? "#f5f4f1" : "#0d0d0d";
}

/** Convenience: both colours in one read (avoids double fs read). */
export function readThemeSurface(): { surface: string; bg: string } {
  const isLight = readStoredTheme() === "light";
  return {
    surface: isLight ? "#ffffff" : "#141414",
    bg: isLight ? "#f5f4f1" : "#0d0d0d",
  };
}
