"use client";

import React, { useMemo, useEffect } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { X } from "lucide-react";
import { urlTransform } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";
import { Callout } from "./Callout";
import { MathBlock } from "./MathBlock";
import { remarkCallout, remarkObsidianEmbeds, remarkPromoteDisplayMath, makeLatexPlugins, InlineCode } from "@/lib/markdown/pipeline";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PREVIEW_REMARK_PLUGINS: any[] = [remarkGfm, remarkBreaks, remarkMath, remarkPromoteDisplayMath, remarkCallout, remarkObsidianEmbeds];

interface MDPreviewPanelProps {
  text: string;
  onDismiss: () => void;
}

export function MDPreviewPanel({ text, onDismiss }: MDPreviewPanelProps) {
  const { rehypeCaptureLatex: previewCapture, rehypeMergedPass: previewMerge } = useMemo(() => makeLatexPlugins(), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onDismiss(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      data-md-preview-portal
      className="flex-shrink-0 border-t border-[var(--border)] animate-fade-in"
      style={{ background: "var(--surface)" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-[var(--border)]" style={{ background: "var(--surface-2)" }}>
        <span className="text-[0.714rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">Preview</span>
        <button
          onClick={onDismiss}
          aria-label="Close preview"
          className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors"
        >
          <X size={11} />
        </button>
      </div>
      <div className="prose-cairn px-6 py-4 overflow-y-auto" style={{ maxHeight: "30vh" }}>
        <ReactMarkdown
          remarkPlugins={PREVIEW_REMARK_PLUGINS}
          rehypePlugins={[previewCapture, rehypeKatex, previewMerge]}
          urlTransform={urlTransform}
          components={({
            mark({ children }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
              return (
                <mark className="rounded px-0.5" style={{ background: "color-mix(in srgb, var(--accent) 22%, transparent)", color: "var(--text-primary)" }}>
                  {children}
                </mark>
              );
            },
            callout({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
              const p = props as Record<string, string>;
              return (
                <Callout
                  type={p["data-callout-type"] ?? "note"}
                  title={p["data-title"] || undefined}
                  collapsible={p["data-collapsible"] === "true"}
                  defaultOpen={p["data-default-open"] !== "false"}
                >
                  {children}
                </Callout>
              );
            },
            mathblock({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
              const p = props as Record<string, string>;
              return <MathBlock renderedChildren={children} latex={p["data-latex"] ?? ""} />;
            },
            pre({ children }: React.HTMLAttributes<HTMLPreElement> & ExtraProps) {
              const child = Array.isArray(children) ? children[0] : children;
              const code = child as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
              const className = code?.props?.className ?? "";
              const lang = className.replace("language-", "") || undefined;
              const content = String(code?.props?.children ?? "").replace(/\n$/, "");
              return <CodeBlock code={content} language={lang} />;
            },
            code({ children, className }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
              return <InlineCode className={className}>{children}</InlineCode>;
            },
          } as import("react-markdown").Components)}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}
