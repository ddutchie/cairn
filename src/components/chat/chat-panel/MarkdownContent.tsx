"use client";

import React, { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import { MermaidDiagram } from "@/components/notes/MermaidDiagram";
import { CodeBlock } from "@/components/notes/CodeBlock";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { CairnEvents } from "@/lib/events";
import { parseWikilinks } from "@/lib/wikilink-parser";
import type { Note, TaskCard } from "@/types";

/**
 * Pre-processes markdown text, replacing [[Note Title]] and file backticks with custom URI markdown links.
 */
function preprocessMarkdown(
  content: string,
  notes: Note[],
  cards: TaskCard[],
  cwd: string | null
): string {
  let processed = content;

  // 1. Replace wikilinks [[Title]]
  const wikilinks = parseWikilinks(content);
  const sortedWikilinks = [...wikilinks].sort((a, b) => b.index - a.index);

  for (const wl of sortedWikilinks) {
    const title = wl.title;
    const note = notes.find((n) => n.title.toLowerCase() === title.toLowerCase() && !n.archivedAt);
    if (note) {
      const link = `[${note.title}](cairn://note/${note.id})`;
      processed = processed.slice(0, wl.index) + link + processed.slice(wl.end);
      continue;
    }
    const card = cards.find((c) => c.title.toLowerCase() === title.toLowerCase() && !c.archivedAt);
    if (card) {
      const link = `[${card.title}](cairn://task/${card.id})`;
      processed = processed.slice(0, wl.index) + link + processed.slice(wl.end);
    }
  }

  // 2. Replace backticked file paths
  if (!cwd) return processed;

  const backtickRegex = /`([^`\n]+?)`/g;
  const backtickMatches: { text: string; index: number; end: number }[] = [];
  let match;
  while ((match = backtickRegex.exec(content)) !== null) {
    const text = match[1].trim();
    if (text) {
      const isFilePath = /\.[a-zA-Z0-9]{1,10}$/.test(text) || text.includes("/") || text.includes("\\");
      if (isFilePath) {
        backtickMatches.push({
          text,
          index: match.index,
          end: match.index + match[0].length,
        });
      }
    }
  }

  backtickMatches.sort((a, b) => b.index - a.index);
  for (const bm of backtickMatches) {
    const cleanCwd = cwd.endsWith("/") || cwd.endsWith("\\") ? cwd.slice(0, -1) : cwd;
    const cleanPath = bm.text.startsWith("/") || bm.text.startsWith("\\") ? bm.text.slice(1) : bm.text;
    const absolutePath = `${cleanCwd}/${cleanPath}`;
    
    const encodedPath = encodeURIComponent(absolutePath);
    const link = `[\`${bm.text}\`](cairn://file/${encodedPath})`;
    processed = processed.slice(0, bm.index) + link + processed.slice(bm.end);
  }

  return processed;
}

/** Markdown renderer for assistant chat messages */
export function MarkdownContent({ content, isUser }: { content: string; isUser?: boolean }) {
  const { notes, cards, projects, activeProjectId, setView, openEditorFile } = useCairnStore(useShallow((s) => ({
    notes: s.notes,
    cards: s.cards,
    projects: s.projects,
    activeProjectId: s.activeProjectId,
    setView: s.setView,
    openEditorFile: s.openEditorFile,
  })));

  const activeProject = useMemo(() => projects.find((p) => p.id === activeProjectId), [projects, activeProjectId]);
  const cwd = activeProject?.codeDirectory ?? null;

  const preprocessed = useMemo(() => {
    return preprocessMarkdown(content, notes, cards, cwd);
  }, [content, notes, cards, cwd]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[rehypeRaw]}
      urlTransform={(url) => url.startsWith("cairn://") ? url : defaultUrlTransform(url)}
      components={{
        p: ({ children }) => <p className="mb-1.5 last:mb-0 leading-relaxed break-words">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>,
        em: ({ children }) => <em className="italic opacity-80">{children}</em>,
        ul: ({ children }) => <ul className="my-1.5 pl-4 list-disc space-y-0.5 text-[var(--text-secondary)]">{children}</ul>,
        ol: ({ children }) => <ol className="my-1.5 pl-4 list-decimal space-y-0.5 text-[var(--text-secondary)]">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed break-words">{children}</li>,
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
            <code className="px-1 py-0.5 rounded bg-[var(--surface-3)] font-mono text-[0.786rem] text-[var(--text-primary)] break-all">
              {children}
            </code>
          );
        },
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-[var(--accent)] pl-2.5 my-1.5 text-[var(--text-tertiary)] italic">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => {
          const linkClass = isUser
            ? "inline-flex items-center text-white hover:text-white/80 underline font-medium cursor-pointer"
            : "inline-flex items-center text-[var(--accent)] hover:underline font-medium cursor-pointer";
          const fallbackClass = isUser
            ? "text-white hover:text-white/80 underline"
            : "text-[var(--accent)] hover:underline";

          if (href?.startsWith("cairn://note/")) {
            const noteId = href.replace("cairn://note/", "");
            return (
              <button
                type="button"
                onClick={() => {
                  setView("notes");
                  setTimeout(() => window.dispatchEvent(CairnEvents.selectNote(noteId)), 50);
                }}
                className={linkClass}
              >
                {children}
              </button>
            );
          }
          if (href?.startsWith("cairn://task/")) {
            const cardId = href.replace("cairn://task/", "");
            return (
              <button
                type="button"
                onClick={() => {
                  setView("board");
                  setTimeout(() => window.dispatchEvent(CairnEvents.openCard(cardId)), 50);
                }}
                className={linkClass}
              >
                {children}
              </button>
            );
          }
          if (href?.startsWith("cairn://file/")) {
            const encodedPath = href.replace("cairn://file/", "");
            const absolutePath = decodeURIComponent(encodedPath);
            return (
              <button
                type="button"
                onClick={() => {
                  setView("agent");
                  openEditorFile(absolutePath);
                }}
                className={linkClass}
              >
                {children}
              </button>
            );
          }
          return (
            <a href={href} className={fallbackClass} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        },
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
      {preprocessed}
    </ReactMarkdown>
  );
}
