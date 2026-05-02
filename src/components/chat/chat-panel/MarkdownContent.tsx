"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "@/components/notes/MermaidDiagram";
import { CodeBlock } from "@/components/notes/CodeBlock";

/** Markdown renderer for assistant chat messages */
export function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>,
        em: ({ children }) => <em className="italic opacity-80">{children}</em>,
        ul: ({ children }) => <ul className="my-1.5 pl-4 list-disc space-y-0.5 text-[var(--text-secondary)]">{children}</ul>,
        ol: ({ children }) => <ol className="my-1.5 pl-4 list-decimal space-y-0.5 text-[var(--text-secondary)]">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        h1: ({ children }) => <h1 className="font-semibold text-[var(--text-primary)] text-sm mt-2 mb-1">{children}</h1>,
        h2: ({ children }) => <h2 className="font-semibold text-[var(--text-primary)] text-sm mt-2 mb-1">{children}</h2>,
        h3: ({ children }) => <h3 className="font-medium text-[var(--text-primary)] mt-1.5 mb-0.5">{children}</h3>,
        pre: ({ children }) => {
          const child = Array.isArray(children) ? children[0] : children;
          const code = child as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
          const className = code?.props?.className ?? "";
          const lang = className.replace("language-", "") || undefined;
          const content = String(code?.props?.children ?? "").replace(/\n$/, "");
          if (lang === "mermaid") return <MermaidDiagram chart={content} />;
          return <CodeBlock code={content} language={lang} />;
        },
        code: ({ children, className }) => {
          // Fenced blocks handled by `pre` above — this only runs for inline code
          if (className?.startsWith("language-")) return <>{children}</>;
          return (
            <code className="px-1 py-0.5 rounded bg-[var(--surface-3)] font-mono text-[0.786rem] text-[var(--text-primary)]">
              {children}
            </code>
          );
        },
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-[var(--accent)] pl-2.5 my-1.5 text-[var(--text-tertiary)] italic">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a href={href} className="text-[var(--accent)] hover:underline" target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        hr: () => <hr className="my-2 border-[var(--border)]" />,
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead>{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr className="border-b border-[var(--border)]">{children}</tr>,
        th: ({ children }) => (
          <th className="px-2.5 py-1.5 text-left font-semibold text-[var(--text-primary)] bg-[var(--surface-2)] border border-[var(--border)]">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="px-2.5 py-1.5 text-[var(--text-secondary)] border border-[var(--border)]">
            {children}
          </td>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
