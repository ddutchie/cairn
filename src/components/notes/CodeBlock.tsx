"use client";

/**
 * CodeBlock — syntax-highlighted fenced code block for ReactMarkdown.
 *
 * Uses lowlight (highlight.js grammars, tree-based, no DOM manipulation)
 * to tokenise code at render time. Token colours use CSS variables so they
 * automatically match the active Cairn theme.
 *
 * Features:
 *  - Language label in the header bar (top-right)
 *  - Copy button (top-right, shows a checkmark for 2s after copy)
 *  - Falls back to plain monospace if the language is unrecognised
 *  - theme-aware: dark uses One Dark-style palette, light uses a softer palette
 */

import { useMemo, useState, useCallback } from "react";
import { common, createLowlight } from "lowlight";
import { Check, Copy } from "lucide-react";

const lowlight = createLowlight(common);

// ── Token colour map ──────────────────────────────────────────────────────────
//
// Maps highlight.js token class names to CSS colour values.
// We define two palettes and pick based on data-theme on <html>.
// Keeping this inline (not global CSS) means no style-sheet collisions.

type Palette = Record<string, string>;

const DARK: Palette = {
  // Keywords: if, const, function, return, class …
  "hljs-keyword":        "#c678dd",
  "hljs-built_in":       "#e5c07b",
  // Literals: true, false, null, undefined
  "hljs-literal":        "#56b6c2",
  // Numbers
  "hljs-number":         "#d19a66",
  // Strings (all flavours)
  "hljs-string":         "#98c379",
  "hljs-template-tag":   "#98c379",
  "hljs-template-variable": "#e06c75",
  // Regexp
  "hljs-regexp":         "#98c379",
  // Comments
  "hljs-comment":        "#5c6370",
  "hljs-quote":          "#5c6370",
  // Variable names / identifiers
  "hljs-variable":       "#e06c75",
  "hljs-attr":           "#e06c75",
  "hljs-attribute":      "#e06c75",
  // Function / method names
  "hljs-title":          "#61afef",
  "hljs-title.class_":   "#e5c07b",
  "hljs-title.function_":"#61afef",
  // Types, classes
  "hljs-type":           "#e5c07b",
  "hljs-class":          "#e5c07b",
  // Operators & punctuation — left at default text colour
  "hljs-operator":       "#56b6c2",
  "hljs-punctuation":    "#abb2bf",
  // Tags (HTML/JSX)
  "hljs-tag":            "#e06c75",
  "hljs-name":           "#e06c75",
  "hljs-selector-tag":   "#e06c75",
  "hljs-selector-id":    "#61afef",
  "hljs-selector-class": "#e5c07b",
  // Meta / preprocessor
  "hljs-meta":           "#61afef",
  "hljs-meta-keyword":   "#c678dd",
  "hljs-meta-string":    "#98c379",
  // Diff
  "hljs-addition":       "#98c379",
  "hljs-deletion":       "#e06c75",
  // Section / heading (markdown inside code?)
  "hljs-section":        "#61afef",
  "hljs-bullet":         "#e5c07b",
  "hljs-link":           "#98c379",
  "hljs-symbol":         "#61afef",
  "hljs-formula":        "#56b6c2",
  "hljs-emphasis":       "#e5c07b",
  "hljs-strong":         "#ffffff",
};

const LIGHT: Palette = {
  "hljs-keyword":        "#7c3aed",
  "hljs-built_in":       "#b45309",
  "hljs-literal":        "#0891b2",
  "hljs-number":         "#c2410c",
  "hljs-string":         "#16a34a",
  "hljs-template-tag":   "#16a34a",
  "hljs-template-variable": "#dc2626",
  "hljs-regexp":         "#16a34a",
  "hljs-comment":        "#9ca3af",
  "hljs-quote":          "#9ca3af",
  "hljs-variable":       "#dc2626",
  "hljs-attr":           "#dc2626",
  "hljs-attribute":      "#dc2626",
  "hljs-title":          "#1d4ed8",
  "hljs-title.class_":   "#b45309",
  "hljs-title.function_":"#1d4ed8",
  "hljs-type":           "#b45309",
  "hljs-class":          "#b45309",
  "hljs-operator":       "#0891b2",
  "hljs-punctuation":    "#374151",
  "hljs-tag":            "#dc2626",
  "hljs-name":           "#dc2626",
  "hljs-selector-tag":   "#dc2626",
  "hljs-selector-id":    "#1d4ed8",
  "hljs-selector-class": "#b45309",
  "hljs-meta":           "#1d4ed8",
  "hljs-meta-keyword":   "#7c3aed",
  "hljs-meta-string":    "#16a34a",
  "hljs-addition":       "#16a34a",
  "hljs-deletion":       "#dc2626",
  "hljs-section":        "#1d4ed8",
  "hljs-bullet":         "#b45309",
  "hljs-link":           "#16a34a",
  "hljs-symbol":         "#1d4ed8",
  "hljs-formula":        "#0891b2",
  "hljs-emphasis":       "#b45309",
  "hljs-strong":         "#111827",
};

// ── Token renderer ─────────────────────────────────────────────────────────────

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

function renderNode(node: HastNode, palette: Palette, key: string): React.ReactNode {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "element") {
    const classes = node.properties?.className ?? [];
    // Pick the first class that has a colour in our palette
    const colour = classes.map((c) => palette[c]).find(Boolean);
    const children = node.children?.map((child, i) =>
      renderNode(child, palette, `${key}-${i}`)
    );
    return colour
      ? <span key={key} style={{ color: colour }}>{children}</span>
      : <span key={key}>{children}</span>;
  }
  return null;
}

// ── Component ──────────────────────────────────────────────────────────────────

interface Props {
  /** The raw code string */
  code: string;
  /** Language from the fenced block (e.g. "javascript", "python") */
  language?: string;
}

export function CodeBlock({ code, language }: Props) {
  const [copied, setCopied] = useState(false);

  const isDark = typeof document !== "undefined"
    ? document.documentElement.getAttribute("data-theme") !== "light"
    : true;

  const palette = isDark ? DARK : LIGHT;

  // Tokenise — memoised so it doesn't re-run on every copy-button hover
  const tokens = useMemo(() => {
    if (!language) return null;
    try {
      const registered = lowlight.listLanguages();
      const lang = registered.includes(language) ? language : null;
      if (!lang) return null;
      return lowlight.highlight(lang, code).children as HastNode[];
    } catch {
      return null;
    }
  }, [code, language]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  // Background and default text for the block — slightly different dark/light
  const bgColor   = isDark ? "#161616" : "#f8f7f5";
  const textColor = isDark ? "#abb2bf" : "#374151";
  const borderColor = isDark ? "#2a2a2a" : "#dddad6";
  const headerBg  = isDark ? "#111111" : "#efeeed";

  const displayLang = language ?? "text";

  return (
    <div
      className="my-4 rounded-lg overflow-hidden text-[12.5px] font-mono"
      style={{ border: `1px solid ${borderColor}` }}
    >
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-3 py-1.5"
        style={{ background: headerBg, borderBottom: `1px solid ${borderColor}` }}
      >
        <span
          className="text-[10px] font-sans font-medium tracking-wide uppercase select-none"
          style={{ color: isDark ? "#5c6370" : "#9ca3af" }}
        >
          {displayLang}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors"
          style={{
            color: copied ? (isDark ? "#98c379" : "#16a34a") : (isDark ? "#5c6370" : "#9ca3af"),
          }}
          title="Copy code"
          aria-label="Copy code"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          <span className="text-[10px] font-sans">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>

      {/* Code body — padding via style not className so .prose-cairn pre reset can't override it */}
      <pre
        className="overflow-x-auto leading-relaxed"
        style={{ background: bgColor, color: textColor, margin: 0, padding: "0.75rem 1rem" }}
      >
        <code>
          {tokens
            ? tokens.map((node, i) => renderNode(node, palette, String(i)))
            : code
          }
        </code>
      </pre>
    </div>
  );
}
