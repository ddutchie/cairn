"use client";

/**
 * MermaidDiagram — renders a mermaid code block as an SVG diagram.
 *
 * Used as a custom `code` renderer inside ReactMarkdown for ```mermaid fences.
 * Mermaid is loaded dynamically (browser-only, no SSR).
 *
 * Theme detection: reads the `data-theme` attribute on <html> so diagrams
 * automatically match the active light/dark theme.
 */

import { useEffect, useRef, useState, useId } from "react";

interface Props {
  chart: string;
}

export function MermaidDiagram({ chart }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId().replace(/:/g, ""); // mermaid IDs must not contain colons

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    async function render() {
      const mermaid = (await import("mermaid")).default;

      // Detect theme from the html element's data-theme attribute (set by ThemeProvider)
      const isDark = document.documentElement.getAttribute("data-theme") !== "light";

      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "default",
        // Match our surface/border colours
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

      try {
        const { svg } = await mermaid.render(`mermaid-${id}`, chart.trim());
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message ?? "Invalid diagram");
        }
      }
    }

    render();
    return () => { cancelled = true; };
  }, [chart, id]);

  if (error) {
    return (
      <div className="rounded-md border border-red-400/40 bg-red-400/10 px-3 py-2 my-3">
        <p className="text-xs font-mono text-red-400 font-medium mb-1">Mermaid error</p>
        <p className="text-xs text-[var(--text-secondary)] font-mono whitespace-pre-wrap">{error}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-4 flex justify-center overflow-x-auto [&_svg]:max-w-full"
    />
  );
}
