"use client";

/**
 * DiffViewer — renders unified diff output from a terminal session.
 *
 * Uses parse-diff to extract hunks. Syntax-highlights content lines
 * using the existing lowlight + CodeBlock palette. No external CSS.
 *
 * Lines:
 *   added   (+): green tint bg + hljs-addition colour
 *   deleted (-): red tint bg + hljs-deletion colour
 *   context ( ): var(--background)
 */

import { useMemo, useState } from "react";
import parseDiff from "parse-diff";
import { common, createLowlight } from "lowlight";
import { Copy, Check } from "lucide-react";
import { TerminalManager } from "./TerminalManager";

const lowlight = createLowlight(common);

// ── Palette (reuses CodeBlock.tsx DARK/LIGHT definitions) ────────────────────

type Palette = Record<string, string>;

const PALETTE_DARK: Palette = {
  "hljs-keyword": "#c678dd", "hljs-built_in": "#e5c07b", "hljs-literal": "#56b6c2",
  "hljs-number": "#d19a66", "hljs-string": "#98c379", "hljs-comment": "#5c6370",
  "hljs-variable": "#e06c75", "hljs-attr": "#e06c75", "hljs-title": "#61afef",
  "hljs-type": "#e5c07b", "hljs-operator": "#56b6c2", "hljs-punctuation": "#abb2bf",
  "hljs-tag": "#e06c75", "hljs-meta": "#61afef",
  "hljs-addition": "#98c379", "hljs-deletion": "#e06c75",
};

const PALETTE_LIGHT: Palette = {
  "hljs-keyword": "#7c3aed", "hljs-built_in": "#b45309", "hljs-literal": "#0891b2",
  "hljs-number": "#c2410c", "hljs-string": "#16a34a", "hljs-comment": "#9ca3af",
  "hljs-variable": "#dc2626", "hljs-attr": "#dc2626", "hljs-title": "#1d4ed8",
  "hljs-type": "#b45309", "hljs-operator": "#0891b2", "hljs-punctuation": "#374151",
  "hljs-tag": "#dc2626", "hljs-meta": "#1d4ed8",
  "hljs-addition": "#16a34a", "hljs-deletion": "#dc2626",
};

function getPalette(isDark: boolean): Palette {
  return isDark ? PALETTE_DARK : PALETTE_LIGHT;
}

// ── Hast renderer (same as CodeBlock) ────────────────────────────────────────

interface HastNode { type: string; value?: string; properties?: { className?: string[] }; children?: HastNode[]; }

function renderHast(node: HastNode, palette: Palette, key: string): React.ReactNode {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "element") {
    const classes = node.properties?.className ?? [];
    const colour = classes.map((c) => palette[c]).find(Boolean);
    const children = node.children?.map((child, i) => renderHast(child, palette, `${key}-${i}`));
    return colour
      ? <span key={key} style={{ color: colour }}>{children}</span>
      : <span key={key}>{children}</span>;
  }
  return null;
}

// ── Syntax-highlighted code line ──────────────────────────────────────────────

function HighlightedLine({ content, lang, palette }: { content: string; lang: string | null; palette: Palette }) {
  const tokens = useMemo(() => {
    if (!lang) return null;
    try {
      const registered = lowlight.listLanguages();
      if (!registered.includes(lang)) return null;
      return lowlight.highlight(lang, content).children as HastNode[];
    } catch { return null; }
  }, [content, lang]);

  return (
    <code className="font-mono text-[0.8rem] whitespace-pre">
      {tokens
        ? tokens.map((n, i) => renderHast(n, palette, String(i)))
        : content}
    </code>
  );
}

// ── Language from filename ────────────────────────────────────────────────────

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", cpp: "cpp", cs: "csharp", json: "json", yaml: "yaml", yml: "yaml",
  sh: "bash", bash: "bash", md: "markdown", css: "css", html: "html",
};

function langFromFilename(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? null;
}

// ── Extract raw diff from ANSI-stripped terminal output ───────────────────────

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;

function extractDiff(raw: string): string {
  const stripped = raw.replace(ANSI_RE, "");
  const lines = stripped.split("\n");
  const start = lines.findIndex((l) => l.startsWith("diff --git") || l.startsWith("--- a/"));
  if (start === -1) return "";
  return lines.slice(start).join("\n");
}

// ── DiffViewer ────────────────────────────────────────────────────────────────

interface DiffViewerProps {
  sessionId: string;
}

export function DiffViewer({ sessionId }: DiffViewerProps) {
  const isDark =
    typeof document !== "undefined"
      ? document.documentElement.getAttribute("data-theme") !== "light"
      : true;
  const palette = getPalette(isDark);

  const [copied, setCopied] = useState(false);

  const rawOutput = TerminalManager.getRawOutput(sessionId);
  const diffText = useMemo(() => extractDiff(rawOutput), [rawOutput]);
  const files = useMemo(() => {
    if (!diffText) return [];
    try { return parseDiff(diffText); } catch { return []; }
  }, [diffText]);

  const handleCopy = () => {
    navigator.clipboard.writeText(diffText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (!diffText || files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-[var(--text-tertiary)] p-8 text-center">
        No diff output detected yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
        <span className="text-[0.714rem] text-[var(--text-tertiary)] flex-1">
          {files.length} file{files.length !== 1 ? "s" : ""} changed
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy patch"}
        </button>
      </div>

      {/* Files */}
      <div className="flex-1 overflow-y-auto">
        {files.map((file, fi) => {
          const filename = file.to ?? file.from ?? "unknown";
          const lang = langFromFilename(filename);
          return (
            <div key={fi} className="border-b border-[var(--border)]">
              {/* File header */}
              <div className="px-3 py-1.5 bg-[var(--surface)] text-[0.786rem] font-mono font-medium text-[var(--text-secondary)] sticky top-0">
                {file.from !== file.to && file.from !== "/dev/null"
                  ? `${file.from} → ${filename}`
                  : filename}
              </div>
              {/* Hunks */}
              {file.chunks.map((chunk, ci) => (
                <div key={ci}>
                  {/* Hunk header */}
                  <div className="px-3 py-0.5 text-[0.714rem] text-[var(--text-tertiary)] bg-[var(--surface)] font-mono border-y border-[var(--border-subtle)]">
                    {chunk.content}
                  </div>
                  {/* Lines */}
                  {chunk.changes.map((change, li) => {
                    const isAdd = change.type === "add";
                    const isDel = change.type === "del";
                    const content = change.content.slice(1); // strip sigil
                    const sigil = change.content[0];

                    return (
                      <div
                        key={li}
                        className="flex font-mono text-[0.8rem] leading-relaxed"
                        style={{
                          background: isAdd
                            ? "color-mix(in srgb, #22c55e 10%, transparent)"
                            : isDel
                              ? "color-mix(in srgb, #ef4444 10%, transparent)"
                              : undefined,
                        }}
                      >
                        {/* Line numbers */}
                        <span className="w-10 text-right pr-2 text-[var(--text-tertiary)] select-none flex-shrink-0 border-r border-[var(--border-subtle)]">
                          {"ln" in change && change.type !== "add" ? (change as { ln: number }).ln : ""}
                        </span>
                        <span className="w-10 text-right pr-2 text-[var(--text-tertiary)] select-none flex-shrink-0 border-r border-[var(--border-subtle)]">
                          {"ln" in change && change.type !== "del" ? (change as { ln: number }).ln : ""}
                        </span>
                        {/* Sigil */}
                        <span
                          className="w-4 text-center select-none flex-shrink-0"
                          style={{
                            color: isAdd
                              ? palette["hljs-addition"]
                              : isDel
                                ? palette["hljs-deletion"]
                                : "var(--text-tertiary)",
                          }}
                        >
                          {sigil}
                        </span>
                        {/* Content */}
                        <span
                          className="flex-1 px-2 overflow-x-auto"
                          style={{
                            color: isAdd
                              ? palette["hljs-addition"]
                              : isDel
                                ? palette["hljs-deletion"]
                                : "var(--text-primary)",
                          }}
                        >
                          <HighlightedLine content={content} lang={lang} palette={palette} />
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
