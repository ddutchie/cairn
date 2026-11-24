/**
 * Workspace entity kinds as the pixel games draw them: a hue set per kind (the
 * Task Force enemy colours), a five-step stone ramp (dark → light) for
 * Stacker, and a 5×5 icon (folder, page, tick, tag).
 */

export type EntityKind = "project" | "note" | "card" | "tag";

export interface KindStyle {
  /** Short label for floating text ("TASK: …"). */
  name: string;
  /** Body, dark and light accents. */
  h: string;
  d: string;
  l: string;
  /** Stone ramp, darkest first. */
  stone: [string, string, string, string, string];
}

export const KINDS: Record<EntityKind, KindStyle> = {
  project: { name: "PROJECT", h: "#2ec4b6", d: "#1b7d75", l: "#a8f4e8", stone: ["#2f5753", "#3d6f6b", "#4f8a84", "#6fa9a2", "#9fd0c8"] },
  note: { name: "NOTE", h: "#5b8dd6", d: "#2f4f8f", l: "#c7e4ff", stone: ["#353f5a", "#45577a", "#5a6f96", "#7a8fb4", "#a9bad6"] },
  card: { name: "TASK", h: "#7cc46a", d: "#3f7a36", l: "#e9ff9a", stone: ["#3a5230", "#4d6a3f", "#64864f", "#84a66a", "#b0cc92"] },
  tag: { name: "TAG", h: "#e3a23b", d: "#8f5a1c", l: "#fff0a8", stone: ["#5c4429", "#7a5a36", "#9a7447", "#bb9561", "#ddbf8a"] },
};

/** 5×5 bit strings, rows top to bottom. */
export const ICONS: Record<EntityKind, string> = {
  project: "1110011111100011000111111",
  note: "1111010011111011000111111",
  card: "0000100011101101110001000",
  tag: "1110010010110010100100110",
};

export interface Label {
  label: string;
  kind: EntityKind;
}

/** Stand-in workspace for when the phone's database has nothing to show yet. */
export const DEMO_LABELS: Label[] = (
  [
    ["Cairn Mobile", "project"], ["Sync design", "note"], ["Fix sync conflict", "card"], ["mobile", "tag"],
    ["Website Relaunch", "project"], ["Release checklist", "note"], ["Offline queue retry", "card"], ["design", "tag"],
    ["Q1 Planning", "project"], ["QA script", "note"], ["Push opt-in flow", "card"], ["urgent", "tag"],
    ["Kitchen Reno", "project"], ["Brand voice", "note"], ["Search highlight", "card"], ["home", "tag"],
    ["Garden", "project"], ["Moodboard", "note"], ["Dark mode contrast", "card"], ["research", "tag"],
    ["Ideas", "project"], ["Sitemap", "note"], ["Widget empty state", "card"], ["later", "tag"],
    ["Reading list", "project"], ["Headcount", "note"], ["Haptics on reorder", "card"], ["q1", "tag"],
    ["Team offsite", "project"], ["Floor plan", "note"], ["Attachment previews", "card"], ["blocked", "tag"],
    ["Side quest", "project"], ["Launch notes", "note"], ["Crash on large notes", "card"], ["bug", "tag"],
    ["Archive", "project"], ["Contacts", "note"], ["Onboarding copy", "card"], ["copy", "tag"],
    ["Book offsite", "card"], ["Last year review", "note"],
  ] as const
).map(([label, kind]) => ({ label, kind }));

/** Mix two `#rrggbb` colours; `f` = 0 gives `a`. */
export function lerpHex(a: string, b: string, f: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  let out = "#";
  for (const sh of [16, 8, 0]) {
    const x = (pa >> sh) & 255, y = (pb >> sh) & 255;
    out += Math.round(x + (y - x) * f).toString(16).padStart(2, "0");
  }
  return out;
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
