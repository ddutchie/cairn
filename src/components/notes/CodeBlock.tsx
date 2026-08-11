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

import { useMemo, useCallback, useState, useEffect } from "react";
import { Check, Copy } from "lucide-react";
import { useIsDark } from "@/hooks/useIsDark";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { SYNTAX_COLORS } from "@/lib/syntax-palette";
import { ensureLanguage, isLanguageReady, highlightCode, onLanguageReady } from "@/lib/lazy-lowlight";

// ── Token colour map ──────────────────────────────────────────────────────────
//
// Maps highlight.js token class names to CSS colour values.
// We define two palettes and pick based on data-theme on <html>.
// Keeping this inline (not global CSS) means no style-sheet collisions.

type Palette = Record<string, string>;

// Both palettes are derived from the shared `SYNTAX_COLORS` tokens so the four
// syntax-highlight consumers (CodeBlock, editor-theme, dashboard-view, PDF
// export) stay in lockstep. `variant` picks the dark/light hex per token.
function buildPalette(variant: "dark" | "light"): Palette {
  const c = (name: keyof typeof SYNTAX_COLORS) => SYNTAX_COLORS[name][variant];
  return {
    // Keywords: if, const, function, return, class …
    "hljs-keyword":        c("keyword"),
    "hljs-built_in":       c("builtin"),
    // Literals: true, false, null, undefined
    "hljs-literal":        c("literal"),
    // Numbers
    "hljs-number":         c("number"),
    // Strings (all flavours)
    "hljs-string":         c("string"),
    "hljs-template-tag":   c("string"),
    "hljs-template-variable": c("variable"),
    // Regexp
    "hljs-regexp":         c("string"),
    // Comments
    "hljs-comment":        c("comment"),
    "hljs-quote":          c("comment"),
    // Variable names / identifiers
    "hljs-variable":       c("variable"),
    "hljs-attr":           c("variable"),
    "hljs-attribute":      c("variable"),
    // Function / method names
    "hljs-title":          c("func"),
    "hljs-title.class_":   c("builtin"),
    "hljs-title.function_":c("func"),
    // Types, classes
    "hljs-type":           c("builtin"),
    "hljs-class":          c("builtin"),
    // Operators & punctuation
    "hljs-operator":       c("literal"),
    "hljs-punctuation":    c("punctuation"),
    // Tags (HTML/JSX)
    "hljs-tag":            c("variable"),
    "hljs-name":           c("variable"),
    "hljs-selector-tag":   c("variable"),
    "hljs-selector-id":    c("func"),
    "hljs-selector-class": c("builtin"),
    // Meta / preprocessor
    "hljs-meta":           c("func"),
    "hljs-meta-keyword":   c("keyword"),
    "hljs-meta-string":    c("string"),
    // Diff
    "hljs-addition":       c("string"),
    "hljs-deletion":       c("variable"),
    // Section / heading (markdown inside code?)
    "hljs-section":        c("func"),
    "hljs-bullet":         c("builtin"),
    "hljs-link":           c("string"),
    "hljs-symbol":         c("func"),
    "hljs-formula":        c("literal"),
    "hljs-emphasis":       c("builtin"),
    "hljs-strong":         c("strong"),
  };
}

const DARK: Palette = buildPalette("dark");
const LIGHT: Palette = buildPalette("light");

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
  const { copied, copy } = useCopyToClipboard();

  const isDark = useIsDark();

  const palette = isDark ? DARK : LIGHT;

  // Grammars load lazily (per-language dynamic import). `ready` flips to true
  // once the requested language's grammar chunk has resolved, triggering a
  // re-highlight. Until then the block renders as plain text (a brief flash on
  // the first-ever view of a given language).
  const [ready, setReady] = useState(() => isLanguageReady(language));
  useEffect(() => {
    // Kick off the load (no-op if already registered/unknown) and subscribe so
    // this block re-renders when ANY grammar finishes — cheap, and we re-check
    // our own language below.
    if (ensureLanguage(language)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReady(true);
      return;
    }
    if (isLanguageReady(language)) { setReady(true); return; }
    const off = onLanguageReady(() => {
      if (isLanguageReady(language)) setReady(true);
    });
    return off;
  }, [language]);

  // Tokenise — memoised so it doesn't re-run on every copy-button hover. Only
  // produces tokens once the grammar is ready; otherwise renders plain text.
  const tokens = useMemo(() => {
    if (!language || !ready) return null;
    return highlightCode(language, code) as HastNode[] | null;
  }, [code, language, ready]);

  const handleCopy = useCallback(() => {
    copy(code);
  }, [code, copy]);

  // Background and default text for the block — slightly different dark/light
  const bgColor   = isDark ? "#161616" : "#f8f7f5";
  const textColor = isDark ? "#abb2bf" : "#374151";
  const borderColor = isDark ? "#2a2a2a" : "#dddad6";
  const headerBg  = isDark ? "#111111" : "#efeeed";

  const displayLang = language ?? "text";

  return (
    <div
      data-cairn-codeblock=""
      className="my-4 rounded-lg overflow-hidden text-sm font-mono"
      style={{ border: `1px solid ${borderColor}` }}
    >
      {/* Header bar */}
      <div
        data-cairn-codeblock-header=""
        className="flex items-center justify-between px-3 py-1.5"
        style={{ background: headerBg, borderBottom: `1px solid ${borderColor}` }}
      >
        <span
          className="text-[0.714rem] font-sans font-medium tracking-wide uppercase select-none"
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
          <span className="text-[0.714rem] font-sans">{copied ? "Copied" : "Copy"}</span>
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
