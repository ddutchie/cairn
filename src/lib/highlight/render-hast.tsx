"use client";

import { useMemo, type ReactNode } from "react";
import { useIsDark } from "@/hooks/useIsDark";
import { buildHljsPalette } from "@/lib/syntax-palette";

/** Flat `hljs-*` class → hex map, built from the shared syntax tokens. */
export type Palette = Record<string, string>;

/** Minimal lowlight/hast node shape (no lowlight import needed to render). */
export interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

/** Render a lowlight hast tree to spans, coloured by first matching palette class. */
export function renderHast(node: HastNode, palette: Palette, key: string): ReactNode {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "element") {
    const colour = (node.properties?.className ?? []).map((c) => palette[c]).find(Boolean);
    const children = node.children?.map((child, i) => renderHast(child, palette, `${key}-${i}`));
    return colour ? (
      <span key={key} style={{ color: colour }}>
        {children}
      </span>
    ) : (
      <span key={key}>{children}</span>
    );
  }
  return null;
}

/** Theme-aware palette from the shared syntax tokens (memoised per theme). */
export function usePalette(): Palette {
  const isDark = useIsDark();
  return useMemo(() => buildHljsPalette(isDark ? "dark" : "light"), [isDark]);
}
