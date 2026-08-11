"use client";

/**
 * MermaidDiagram — renders a mermaid code block as an SVG diagram.
 *
 * Used as a custom `code` renderer inside ReactMarkdown for ```mermaid fences.
 * Mermaid is loaded dynamically (browser-only, no SSR).
 *
 * Theme detection: reads the `data-theme` attribute on <html> so diagrams
 * automatically match the active light/dark theme.
 *
 * Expand button appears on hover — opens a full-screen modal with the diagram
 * rendered at unconstrained size. Close with Escape or by clicking the backdrop.
 */

import { useEffect, useRef, useState, useId, useCallback } from "react";
import { Maximize2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getIsDark } from "@/lib/utils";
import { useIsDark } from "@/hooks/useIsDark";

interface Props {
  chart: string;
}

// Shared mermaid initialisation helper — called before every render so the
// theme is always up to date (user may have switched between light and dark).
async function getMermaid(id: string) {
  const mermaid = (await import("mermaid")).default;
  
  // Prevent mermaid from throwing uncaught errors globally that bubble up to Next.js
  mermaid.parseError = () => {};

  const isDark = getIsDark();
  mermaid.initialize({
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: isDark ? "dark" : "default",
    themeVariables: isDark
      ? {
          background: "#141414",
          mainBkg: "#1a1a1a",
          nodeBorder: "#2a2a2a",
          lineColor: "#9e9a94",
          textColor: "#e8e4dc",
          edgeLabelBackground: "#1a1a1a",
          clusterBkg: "#1a1a1a",
          titleColor: "#e8e4dc",
        }
      : {
          background: "#ffffff",
          mainBkg: "#f0eeeb",
          nodeBorder: "#dddad6",
          lineColor: "#4a4744",
          textColor: "#1a1917",
          edgeLabelBackground: "#ffffff",
          clusterBkg: "#f0eeeb",
          titleColor: "#1a1917",
        },
  });
  return { mermaid, id };
}

// ── Subgraph label contrast ───────────────────────────────────────────────────

// Subgraphs (clusters) can carry an explicit fill chosen by the diagram author
// (LLM-generated charts often pick light pastels). Mermaid's label colour
// follows the theme — light text in dark mode — so an explicitly-light fill
// becomes unreadable. Fix by computing the actual fill luminance per cluster
// and pinning the label to a contrasting dark/light fill.
export const parseColor = (input: string): [number, number, number] | null => {
  const s = (input ?? "").trim();
  const hex = s.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = s.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgb) return [parseInt(rgb[1], 10), parseInt(rgb[2], 10), parseInt(rgb[3], 10)];
  return null;
};

export const colorLuminance = (input: string): number | null => {
  const rgb = parseColor(input);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio between two relative luminances (1–21). */
export function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function enforceClusterLabelContrast(container: HTMLElement) {
  // FIXED (theme-independent) label candidates from the design tokens — dark
  // text on light fills, light text on dark fills.
  const styles = getComputedStyle(container);
  const darkColor = styles.getPropertyValue("--mermaid-label-dark").trim() || "#1a1917";
  const lightColor = styles.getPropertyValue("--mermaid-label-light").trim() || "#e8e4dc";
  const darkLum = colorLuminance(darkColor);
  const lightLum = colorLuminance(lightColor);

  for (const cluster of container.querySelectorAll<SVGElement>("g.cluster")) {
    const rect = cluster.querySelector<SVGRectElement>("rect") ?? (cluster.firstElementChild as SVGGraphicsElement | null);
    const svgLabel = cluster.querySelector<SVGTextElement>(".cluster-label text, text.cluster-label");
    const htmlLabel = cluster.querySelector<HTMLElement>(".cluster-label span");
    if (!rect) continue;

    // Prefer the rect's own fill; fall back to the computed style when the
    // attribute is missing/"none". If the attribute value is present but fails
    // to parse (e.g. an SVG paint-server url), retry luminance with the
    // computed style before giving up on this cluster.
    const attrFill = rect.getAttribute("fill");
    let luminance = colorLuminance(attrFill && attrFill !== "none" ? attrFill : getComputedStyle(rect).fill);
    if (luminance === null) {
      luminance = colorLuminance(getComputedStyle(rect).fill);
    }
    if (luminance === null) continue;

    // Pick whichever candidate has the HIGHER WCAG contrast against the fill
    // instead of a fixed 0.5-luminance threshold.
    const useDark = darkLum !== null && lightLum !== null
      ? contrastRatio(luminance, darkLum) >= contrastRatio(luminance, lightLum)
      : luminance > 0.5;
    const color = useDark ? darkColor : lightColor;

    if (svgLabel) svgLabel.setAttribute("fill", color);
    if (htmlLabel) htmlLabel.style.color = color;
  }
}

// ── Full-screen modal ─────────────────────────────────────────────────────────

function DiagramModal({ chart, onClose }: { chart: string; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const modalId = useId().replace(/:/g, "") + "modal";
  // Re-render the diagram when the theme flips (getMermaid reads the theme).
  const isDark = useIsDark();

  // Render diagram inside modal
  useEffect(() => {
    let cancelled = false;
    async function render() {
      const { mermaid } = await getMermaid(modalId);
      try {
        const { svg } = await mermaid.render(modalId, chart.trim());
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          enforceClusterLabelContrast(containerRef.current);
          // Remove fixed width/height so SVG scales to fill the modal
          const svgEl = containerRef.current.querySelector("svg");
          if (svgEl) {
            svgEl.removeAttribute("width");
            svgEl.removeAttribute("height");
            // Let Tailwind classes on the container drive sizing;
            // just ensure the SVG doesn't impose its own fixed dimensions.
            svgEl.style.width = "100%";
            svgEl.style.height = "100%";
          }
        }
      } catch { /* errors shown in inline view already */ }
    }
    render();
    return () => { cancelled = true; };
  }, [chart, modalId, isDark]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="full" className="w-[90vw] h-[88vh] max-w-none flex flex-col p-6 animate-slide-in-up" aria-describedby="mermaid-desc">
        <DialogTitle className="sr-only">Fullscreen Mermaid Diagram</DialogTitle>
        <div id="mermaid-desc" className="sr-only">
          Detailed full-screen visualization of the rendered Mermaid chart.
        </div>
        {/* Container fills all remaining space; SVG is told to fill it */}
        <div
          ref={containerRef}
          className="flex-1 flex justify-center items-center min-h-0 [&_svg]:w-full [&_svg]:h-full [&_svg]:max-w-full [&_svg]:max-h-full"
        />
      </DialogContent>
    </Dialog>
  );
}

// ── Inline diagram ────────────────────────────────────────────────────────────

export function MermaidDiagram({ chart }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const id = useId().replace(/:/g, "");
  // Re-render on live theme switch (getMermaid reads the active theme once).
  const isDark = useIsDark();

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    async function render() {
      const { mermaid } = await getMermaid(id);
      try {
        const { svg } = await mermaid.render(`mermaid-${id}`, chart.trim());
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          enforceClusterLabelContrast(containerRef.current);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? "Invalid diagram");
      }
    }
    render();
    return () => { cancelled = true; };
  }, [chart, id, isDark]);

  const handleExpand = useCallback(() => setExpanded(true), []);

  if (error) {
    return (
      <div className="rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 my-3">
        <p className="text-xs font-mono text-[var(--danger)] font-medium mb-1">Mermaid error</p>
        <p className="text-xs text-[var(--text-secondary)] font-mono whitespace-pre-wrap">{error}</p>
      </div>
    );
  }

  return (
    <>
      <div className="relative my-4 group">
        <div
          ref={containerRef}
          className="flex justify-center overflow-x-auto [&_svg]:max-w-full"
        />
        {/* Expand button — visible on hover */}
        <button
          onClick={handleExpand}
          className="absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          aria-label="View full screen"
          title="View full screen"
        >
          <Maximize2 size={12} />
        </button>
      </div>
      {expanded && (
        <DiagramModal chart={chart} onClose={() => setExpanded(false)} />
      )}
    </>
  );
}
