import type { Theme } from "@/theme";
import { nodeTypeToken, type ThemeToken } from "@cairn/shared/ui/graph";
import type { GraphNodeType } from "@/db/types";

/** Resolve a shared graph theme token to a concrete colour on this platform. */
export function tokenColor(token: ThemeToken, t: Theme): string {
  switch (token) {
    case "accent": return t.accent;
    case "info": return t.info;
    case "success": return t.success;
    case "warning": return t.warning;
    case "border": return t.border;
    case "background": return t.background;
    case "textPrimary": return t.textPrimary;
    case "textSecondary": return t.textSecondary;
    case "textTertiary": return t.textTertiary;
    case "nodeProject": return t.nodeProject;
  }
}

/** Node type → colour, via the shared token map (tags = warning, NOT tag colour). */
export function nodeTypeColor(type: GraphNodeType, t: Theme): string {
  return tokenColor(nodeTypeToken(type), t);
}
