/**
 * Shared accent-colour presets — pure data (no React, no platform deps) so the
 * desktop app, the mobile app, and the Electron splash all offer the SAME set
 * of accent choices and the SAME hex values.
 *
 * Cairn's neutral palette is intentionally *warm* (cream / stone, not pure
 * gray), so each accent ships a separate dark + light trio tuned for that base.
 * Only these four tokens change per preset — every other design token stays
 * fixed. The `fg` value is chosen for WCAG AA contrast on the accent fill.
 *
 * A preset resolves to four CSS custom properties on the desktop
 * (`--accent`, `--accent-hover`, `--accent-fg`, `--accent-dim`) and to the
 * `accent` / `accentHover` / `accentFg` / `accentDim` theme fields on mobile.
 */

/** One accent trio for a single theme (dark or light). */
export interface AccentVariant {
  /** Base accent colour. */
  accent: string;
  /** Hover / pressed accent colour. */
  hover: string;
  /** Foreground colour placed on top of the accent fill (AA contrast). */
  fg: string;
  /** Low-alpha wash used for tints, active-nav backgrounds, callouts. */
  dim: string;
}

export interface AccentPreset {
  /** Stable id — persisted to storage; never reuse or rename. */
  id: string;
  /** Human label shown in the picker. */
  name: string;
  /** One-line description of the vibe. */
  description: string;
  dark: AccentVariant;
  light: AccentVariant;
}

/**
 * The curated accent presets, in picker order.
 *
 * NOTE: keep this in sync with the fallback values baked into
 * `src/app/globals.css` (:root + [data-theme="light"]) and
 * `electron/splash/bootsplash.ts`. `DEFAULT_ACCENT_ID` is the value those files
 * hard-code as their static default.
 */
export const ACCENT_PRESETS: AccentPreset[] = [
  {
    id: "sage",
    name: "Sage Moss",
    description: "Muted natural green. Calm, organic, pairs with warm neutrals.",
    dark: { accent: "#8faf6f", hover: "#a6c487", fg: "#131c0b", dim: "rgba(143, 175, 111, 0.15)" },
    light: { accent: "#5c7a3f", hover: "#4d6733", fg: "#ffffff", dim: "rgba(92, 122, 63, 0.12)" },
  },
  {
    id: "teal",
    name: "Cairn Teal",
    description: "Calm blue-green — stone & water. Clean on warm cream.",
    dark: { accent: "#2dd4bf", hover: "#5eead4", fg: "#052e2b", dim: "rgba(45, 212, 191, 0.15)" },
    light: { accent: "#0a7568", hover: "#08655a", fg: "#ffffff", dim: "rgba(10, 117, 104, 0.12)" },
  },
  {
    id: "terracotta",
    name: "Terracotta",
    description: "Warm clay orange-red. Leans into the cairn / earth identity.",
    dark: { accent: "#f0876a", hover: "#f6a487", fg: "#2b0d05", dim: "rgba(240, 135, 106, 0.15)" },
    light: { accent: "#b84e30", hover: "#a54428", fg: "#ffffff", dim: "rgba(184, 78, 48, 0.12)" },
  },
  {
    id: "amber",
    name: "Amber Gold",
    description: "Warm ochre. Editorial, papery, premium — on-brand for notes.",
    dark: { accent: "#e5a94e", hover: "#f0bd6c", fg: "#2a1c04", dim: "rgba(229, 169, 78, 0.15)" },
    light: { accent: "#a06a15", hover: "#8a5c12", fg: "#ffffff", dim: "rgba(160, 106, 21, 0.12)" },
  },
  {
    id: "obsidian",
    name: "Obsidian Indigo",
    description: "Cool violet — the classic Cairn accent.",
    dark: { accent: "#7c6af7", hover: "#9281ff", fg: "#16082e", dim: "rgba(124, 106, 247, 0.15)" },
    light: { accent: "#6457e8", hover: "#7c6af7", fg: "#ffffff", dim: "rgba(100, 87, 232, 0.12)" },
  },
  {
    id: "slate",
    name: "Slate Blue",
    description: "Desaturated professional blue. Calm and unopinionated.",
    dark: { accent: "#6b91d6", hover: "#88a9e2", fg: "#0a1526", dim: "rgba(107, 145, 214, 0.15)" },
    light: { accent: "#3f66b3", hover: "#35569b", fg: "#ffffff", dim: "rgba(63, 102, 179, 0.12)" },
  },
  {
    id: "coral",
    name: "Rust Coral",
    description: "Warm pink-red. Energetic yet earthy.",
    dark: { accent: "#f2708a", hover: "#f793a6", fg: "#2c0710", dim: "rgba(242, 112, 138, 0.15)" },
    light: { accent: "#c73e5c", hover: "#af3450", fg: "#ffffff", dim: "rgba(199, 62, 92, 0.12)" },
  },
  {
    id: "plum",
    name: "Deep Plum",
    description: "Warm, rich purple — inky but distinct from Obsidian.",
    dark: { accent: "#b981d8", hover: "#cc9be5", fg: "#1e0a26", dim: "rgba(185, 129, 216, 0.15)" },
    light: { accent: "#8b4fad", hover: "#794296", fg: "#ffffff", dim: "rgba(139, 79, 173, 0.12)" },
  },
  {
    id: "pine",
    name: "Pine Green",
    description: "Deep evergreen. Grounded and serious.",
    dark: { accent: "#4fae82", hover: "#6cc39a", fg: "#04140c", dim: "rgba(79, 174, 130, 0.15)" },
    light: { accent: "#217a53", hover: "#1b6746", fg: "#ffffff", dim: "rgba(33, 122, 83, 0.12)" },
  },
  {
    id: "copper",
    name: "Copper Bronze",
    description: "Metallic warm brown-orange. Distinctive and tactile.",
    dark: { accent: "#d69663", hover: "#e3ac80", fg: "#261407", dim: "rgba(214, 150, 99, 0.15)" },
    light: { accent: "#a5652f", hover: "#8d5626", fg: "#ffffff", dim: "rgba(165, 101, 47, 0.12)" },
  },
];

/** The default accent id. Mirrored by the static fallbacks in globals.css. */
export const DEFAULT_ACCENT_ID = "sage";

/** Fast lookup by id. */
export const ACCENT_PRESET_BY_ID: Record<string, AccentPreset> = Object.fromEntries(
  ACCENT_PRESETS.map((p) => [p.id, p]),
);

/** Resolve a stored accent id to a preset, falling back to the default. */
export function resolveAccentPreset(id?: string | null): AccentPreset {
  if (id && ACCENT_PRESET_BY_ID[id]) return ACCENT_PRESET_BY_ID[id];
  return ACCENT_PRESET_BY_ID[DEFAULT_ACCENT_ID];
}
