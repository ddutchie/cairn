/** Workspace entity kinds in the arcade palette (same hues as mobile). */

import type { EntityKind } from "../data";
import { scr } from "./kit";

export interface KindStyle {
  name: string;
  h: string;
  d: string;
  l: string;
  /** Dark → light ramp, for Stacker stones. */
  stone: string[];
}

export const KINDS: Record<EntityKind, KindStyle> = {
  project: { name: "PROJECT", h: "#2ec4b6", d: "#1b7d75", l: "#a8f4e8", stone: ["#2f5753", "#3d6f6b", "#4f8a84", "#6fa9a2", "#9fd0c8"] },
  note: { name: "NOTE", h: "#5b8dd6", d: "#2f4f8f", l: "#c7e4ff", stone: ["#353f5a", "#45577a", "#5a6f96", "#7a8fb4", "#a9bad6"] },
  card: { name: "TASK", h: "#7cc46a", d: "#3f7a36", l: "#e9ff9a", stone: ["#3a5230", "#4d6a3f", "#64864f", "#84a66a", "#b0cc92"] },
  tag: { name: "TAG", h: "#e3a23b", d: "#8f5a1c", l: "#fff0a8", stone: ["#5c4429", "#7a5a36", "#9a7447", "#bb9561", "#ddbf8a"] },
};
export const KIND_LIST: EntityKind[] = ["project", "note", "card", "tag"];

/** 5×5 kind icons: folder, page, tick, tag. */
export const ICONS: Record<EntityKind, string> = {
  project: "1110011111100011000111111",
  note: "1111010011111011000111111",
  card: "0000100011101101110001000",
  tag: "1110010010110010100100110",
};

export function icon(kind: EntityKind, x: number, y: number, c: string, g: CanvasRenderingContext2D = scr.ctx): void {
  g.fillStyle = c;
  const s = ICONS[kind];
  for (let i = 0; i < 25; i++) if (s.charCodeAt(i) === 49) g.fillRect(x + (i % 5), y + ((i / 5) | 0), 1, 1);
}

export const PRIORITY_PAL = {
  low: { h: "#7cc46a", d: "#3f7a36", a: "#e9ff9a" },
  medium: { h: "#5b8dd6", d: "#2f4f8f", a: "#c7e4ff" },
  high: { h: "#e3a23b", d: "#8f5a1c", a: "#fff0a8" },
  urgent: { h: "#d9483b", d: "#7a1f22", a: "#ffd2c2" },
} as const;
