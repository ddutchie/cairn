"use client";

import React, { useState } from "react";
import { Code2, Sigma } from "lucide-react";

interface MathBlockProps {
  /** The rendered KaTeX React subtree (from ReactMarkdown children) */
  renderedChildren: React.ReactNode;
  /** The raw LaTeX source to show in source view */
  latex: string;
}

/**
 * Display-math block with a toggle button that switches between the rendered
 * KaTeX view and the raw LaTeX source in a code block.
 *
 * Appears on hover; clicking the button in the top-right corner switches modes.
 */
export function MathBlock({ renderedChildren, latex }: MathBlockProps) {
  const [showSource, setShowSource] = useState(false);

  return (
    <div className="relative my-4" data-math-block="true" style={{ overflow: "visible" }}>
      {/* Toggle button — always softly visible, full opacity on hover */}
      <button
        onClick={() => setShowSource((v) => !v)}
        title={showSource ? "Show rendered math" : "Show LaTeX source"}
        className="absolute top-1 right-0 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.714rem] font-mono transition-opacity"
        style={{
          background: "color-mix(in srgb, var(--surface-3) 90%, transparent)",
          color: "var(--text-secondary)",
          border: "1px solid var(--border)",
          opacity: 0.5,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.5")}
      >
        {showSource ? (
          <Sigma size={11} strokeWidth={1.8} />
        ) : (
          <Code2 size={11} strokeWidth={1.8} />
        )}
        {showSource ? "render" : "source"}
      </button>

      {showSource ? (
        /* LaTeX source view */
        <pre
          className="overflow-x-auto rounded-md px-4 py-3 font-mono text-[0.786rem] leading-relaxed"
          style={{
            background: "var(--surface-2)",
            color: "var(--text-primary)",
            border: "1px solid var(--border)",
          }}
        >
          <code>{latex}</code>
        </pre>
      ) : (
        /* Rendered KaTeX — re-wrap in katex-display so KaTeX CSS applies */
        <span className="katex-display">{renderedChildren}</span>
      )}
    </div>
  );
}
