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
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";

interface Props {
  chart: string;
}

// Shared mermaid initialisation helper — called before every render so the
// theme is always up to date (user may have switched between light and dark).
async function getMermaid(id: string) {
  const mermaid = (await import("mermaid")).default;
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  mermaid.initialize({
    startOnLoad: false,
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

// ── Full-screen modal ─────────────────────────────────────────────────────────

function DiagramModal({ chart, onClose }: { chart: string; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const modalId = useId().replace(/:/g, "") + "modal";

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Render diagram inside modal
  useEffect(() => {
    let cancelled = false;
    async function render() {
      const { mermaid } = await getMermaid(modalId);
      try {
        const { svg } = await mermaid.render(modalId, chart.trim());
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          // Remove fixed width/height so SVG scales to fill the modal
          const svgEl = containerRef.current.querySelector("svg");
          if (svgEl) {
            svgEl.removeAttribute("width");
            svgEl.removeAttribute("height");
            svgEl.style.width = "100%";
            svgEl.style.height = "100%";
            svgEl.style.maxWidth = "100%";
            svgEl.style.maxHeight = "85vh";
          }
        }
      } catch { /* errors shown in inline view already */ }
    }
    render();
    return () => { cancelled = true; };
  }, [chart, modalId]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Panel */}
      <div
        className="relative z-10 w-full max-w-5xl max-h-[90vh] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-1.5 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          aria-label="Close"
        >
          <X size={15} />
        </button>
        <div
          ref={containerRef}
          className="flex justify-center items-center min-h-[200px] [&_svg]:max-w-full"
        />
      </div>
    </div>,
    document.body
  );
}

// ── Inline diagram ────────────────────────────────────────────────────────────

export function MermaidDiagram({ chart }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const id = useId().replace(/:/g, "");

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    async function render() {
      const { mermaid } = await getMermaid(id);
      try {
        const { svg } = await mermaid.render(`mermaid-${id}`, chart.trim());
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? "Invalid diagram");
      }
    }
    render();
    return () => { cancelled = true; };
  }, [chart, id]);

  const handleExpand = useCallback(() => setExpanded(true), []);

  if (error) {
    return (
      <div className="rounded-md border border-red-400/40 bg-red-400/10 px-3 py-2 my-3">
        <p className="text-xs font-mono text-red-400 font-medium mb-1">Mermaid error</p>
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
