"use client";

import React, { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import { rehypeEscapeUnknownTags } from "@/lib/markdown/pipeline";
import { renderCodeFence } from "@/components/notes/markdown-code-fence";
import { renderCellWithCheckboxes } from "@/components/notes/note-markdown-components";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { revealNote, revealCard } from "@/lib/events";
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
  // Fast path: if the message has neither a `[[wikilink]]` nor any backtick
  // span, there's nothing to rewrite — skip the parseWikilinks scan and the
  // backtick regex entirely. This is the common case for assistant prose and
  // matters most during streaming, where this runs on every token.
  const hasWikilink = content.includes("[[");
  const hasBacktick = content.includes("`");
  if (!hasWikilink && !hasBacktick) return content;

  let processed = content;

  // 1. Replace wikilinks [[Title]]
  const wikilinks = hasWikilink ? parseWikilinks(content) : [];
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
  const { notes, cards, projects, activeProjectId, setView, openEditorFile, activeView, setActivePreviewItem } = useCairnStore(useShallow((s) => ({
    notes: s.notes,
    cards: s.cards,
    projects: s.projects,
    activeProjectId: s.activeProjectId,
    setView: s.setView,
    openEditorFile: s.openEditorFile,
    activeView: s.activeView,
    setActivePreviewItem: s.setActivePreviewItem,
  })));

  const activeProject = useMemo(() => projects.find((p) => p.id === activeProjectId), [projects, activeProjectId]);
  const cwd = activeProject?.codeDirectory ?? null;

  const preprocessed = useMemo(() => {
    return preprocessMarkdown(content, notes, cards, cwd);
  }, [content, notes, cards, cwd]);

  // The user bubble has a themed background. All text there renders in the
  // bubble's foreground token (`--chat-user-fg`, falling back to the accent-foreground
  // so the default theme keeps today's behaviour), which is theme-aware and meets
  // AA contrast on the bubble surface. Chrome (borders, code/table backgrounds)
  // use bubble-fg alpha via color-mix. Assistant bubbles keep the dark surface tokens.
  const bubbleFg = "var(--chat-user-fg, var(--accent-fg))";
  const strongColor = isUser ? `text-[${bubbleFg}]` : "text-[var(--text-primary)]";
  const headingColor = isUser ? `text-[${bubbleFg}]` : "text-[var(--text-primary)]";
  const listColor = isUser ? `text-[${bubbleFg}]` : "text-[var(--text-secondary)]";
  const codeClass = isUser
    ? `bg-[color-mix(in_srgb,var(--chat-user-fg,var(--accent-fg))_20%,transparent)] text-[${bubbleFg}]`
    : "bg-[var(--surface-3)] text-[var(--text-primary)]";
  const quoteClass = isUser
    ? `border-[color-mix(in_srgb,var(--chat-user-fg,var(--accent-fg))_40%,transparent)] text-[color-mix(in_srgb,var(--chat-user-fg,var(--accent-fg))_85%,transparent)]`
    : "border-[var(--accent)] text-[var(--text-tertiary)]";
  // Table / rule chrome — re-themed against the user bubble for the user path.
  const ruleBorder = isUser
    ? `border-[color-mix(in_srgb,var(--chat-user-fg,var(--accent-fg))_40%,transparent)]`
    : "border-[var(--border)]";
  const thClass = isUser
    ? `text-[${bubbleFg}] bg-[color-mix(in_srgb,var(--chat-user-fg,var(--accent-fg))_15%,transparent)] border-[color-mix(in_srgb,var(--chat-user-fg,var(--accent-fg))_40%,transparent)]`
    : "text-[var(--text-primary)] bg-[var(--surface-2)] border-[var(--border)]";
  const tdClass = isUser
    ? `text-[${bubbleFg}] border-[color-mix(in_srgb,var(--chat-user-fg,var(--accent-fg))_40%,transparent)]`
    : "text-[var(--text-secondary)] border-[var(--border)]";

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[rehypeRaw, rehypeEscapeUnknownTags]}
      urlTransform={(url) => url.startsWith("cairn://") ? url : defaultUrlTransform(url)}
      components={{
        p: ({ children }) => <p className="mb-1.5 last:mb-0 leading-relaxed break-words">{children}</p>,
        strong: ({ children }) => <strong className={`font-semibold ${strongColor}`}>{children}</strong>,
        em: ({ children }) => <em className="italic opacity-80">{children}</em>,
        ul: ({ children }) => <ul className={`my-1.5 pl-4 list-disc space-y-0.5 ${listColor}`}>{children}</ul>,
        ol: ({ children }) => <ol className={`my-1.5 pl-4 list-decimal space-y-0.5 ${listColor}`}>{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed break-words">{children}</li>,
        h1: ({ children }) => <h1 className={`font-semibold ${headingColor} text-sm mt-2 mb-1`}>{children}</h1>,
        h2: ({ children }) => <h2 className={`font-semibold ${headingColor} text-sm mt-2 mb-1`}>{children}</h2>,
        h3: ({ children }) => <h3 className={`font-medium ${headingColor} mt-1.5 mb-0.5`}>{children}</h3>,
        pre: ({ children }) => renderCodeFence(children),
        code: ({ children, className }) => {
          // Fenced blocks handled by `pre` above — this only runs for inline code
          if (className?.startsWith("language-")) return <>{children}</>;
          return (
            <code className={`px-1 py-0.5 rounded font-mono text-[0.786rem] break-all ${codeClass}`}>
              {children}
            </code>
          );
        },
        blockquote: ({ children }) => (
          <blockquote className={`border-l-2 pl-2.5 my-1.5 italic ${quoteClass}`}>
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => {
          const linkClass = isUser
            ? "inline-flex items-center text-[var(--accent-fg)] hover:text-[color-mix(in_srgb,var(--accent-fg)_85%,transparent)] underline font-medium cursor-pointer"
            : "inline-flex items-center text-[var(--accent)] hover:underline font-medium cursor-pointer";
          const fallbackClass = isUser
            ? "text-[var(--accent-fg)] hover:text-[color-mix(in_srgb,var(--accent-fg)_85%,transparent)] underline"
            : "text-[var(--accent)] hover:underline";

          if (href?.startsWith("cairn://note/")) {
            const noteId = href.replace("cairn://note/", "");
            return (
              <button
                type="button"
                onClick={() => {
                  if (activeView === "chat") {
                    setActivePreviewItem({ type: "note", id: noteId });
                  } else {
                    revealNote(setView, noteId);
                  }
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
                  if (activeView === "chat") {
                    setActivePreviewItem({ type: "task", id: cardId });
                  } else {
                    revealCard(setView, cardId);
                  }
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
        hr: () => <hr className={`my-2 ${ruleBorder}`} />,
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead>{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr className={`border-b ${ruleBorder}`}>{children}</tr>,
        th: ({ children }) => (
          <th className={`px-2.5 py-1.5 text-left font-semibold border ${thClass}`}>
            {renderCellWithCheckboxes(children)}
          </th>
        ),
        td: ({ children }) => (
          <td className={`px-2.5 py-1.5 border ${tdClass}`}>
            {renderCellWithCheckboxes(children)}
          </td>
        ),
      }}
    >
      {preprocessed}
    </ReactMarkdown>
  );
}
