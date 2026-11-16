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
import { ensureLanguage, isLanguageReady, highlightCode, onLanguageReady } from "@/lib/lazy-lowlight";
import { renderHast, usePalette, type HastNode } from "@/lib/highlight/render-hast";
import { Tooltip } from "@/components/ui/tooltip";

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

  const palette = usePalette();

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
          className="text-xs font-sans font-medium tracking-wide uppercase select-none"
          style={{ color: isDark ? "#5c6370" : "#9ca3af" }}
        >
          {displayLang}
        </span>
        <Tooltip content="Copy code">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors"
            style={{
              color: copied ? (isDark ? "#98c379" : "#16a34a") : (isDark ? "#5c6370" : "#9ca3af"),
            }}
            aria-label="Copy code"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            <span className="text-xs font-sans">{copied ? "Copied" : "Copy"}</span>
          </button>
        </Tooltip>
      </div>

      {/* Code body — padding via style not className so .prose-cairn pre reset can't override it */}
      <pre
        className="overflow-x-auto leading-relaxed"
        style={{ background: bgColor, color: textColor, margin: 0, padding: "0.75rem 1rem" }}
      >
        <code>
          {tokens
            ? tokens.map((node, i) => renderHast(node, palette, String(i)))
            : code
          }
        </code>
      </pre>
    </div>
  );
}
