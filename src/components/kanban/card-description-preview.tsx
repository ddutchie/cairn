"use client";

import React, { useMemo } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { parseWikilinks } from "@/lib/wikilink-parser";
import { revealNote, revealCard } from "@/lib/events";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Lightweight description preview for collapsed kanban cards.
 *
 * Deliberately NOT the full markdown pipeline (`NoteMarkdownPreview` =
 * react-markdown + remark/rehype + KaTeX). That stack costs milliseconds per
 * card and blocked the Board mount (~350ms INP) when run for every card. This
 * component is a single `[[wikilink]]` regex scan (microseconds) plus plain
 * text — wikilinks render as clickable pills, everything else stays raw.
 *
 * Full markdown is still used for the expanded card (`card.tsx`) and the
 * card-detail modal (`card-detail-body.tsx`), where only one instance renders.
 */
function CardDescriptionPreviewImpl({ content, projectId, workspaceId }: { content: string; projectId?: string; workspaceId?: string }) {
  const { notes, cards, setView } = useCairnStore(
    useShallow((s) => ({ notes: s.notes, cards: s.cards, setView: s.setView })),
  );

  const segments = useMemo(() => {
    if (!content.includes("[[")) return null;
    const matches = parseWikilinks(content);
    if (matches.length === 0) return null;

    type Seg =
      | { kind: "text"; text: string; key: string }
      | { kind: "link"; title: string; noteId: string | null; cardId: string | null; key: string };

    const findNote = (title: string) => {
      const lower = title.toLowerCase();
      // Prefer a same-project match so duplicate titles resolve locally.
      // Fallbacks stay inside the card's workspace — resolving (and revealing)
      // a same-title note from another workspace would be a wrong link.
      const inWorkspace = (n: { projectId: string; workspaceId: string; archivedAt?: string; title: string }) =>
        (!workspaceId || n.workspaceId === workspaceId) && !n.archivedAt && n.title.toLowerCase() === lower;
      const local = projectId
        ? notes.find((n) => n.projectId === projectId && !n.archivedAt && n.title.toLowerCase() === lower)
        : undefined;
      return local ?? notes.find(inWorkspace);
    };
    const findCard = (title: string) => {
      const lower = title.toLowerCase();
      const inWorkspace = (c: { projectId: string; workspaceId: string; archivedAt?: string; title: string }) =>
        (!workspaceId || c.workspaceId === workspaceId) && !c.archivedAt && c.title.toLowerCase() === lower;
      const local = projectId
        ? cards.find((c) => c.projectId === projectId && !c.archivedAt && c.title.toLowerCase() === lower)
        : undefined;
      return local ?? cards.find(inWorkspace);
    };

    const out: Seg[] = [];
    let cursor = 0;
    matches.forEach((m, i) => {
      if (m.index > cursor) {
        out.push({ kind: "text", text: content.slice(cursor, m.index), key: `t${i}` });
      }
      const note = findNote(m.title);
      const card = note ? undefined : findCard(m.title);
      out.push({
        kind: "link",
        title: m.title,
        noteId: note?.id ?? null,
        cardId: card?.id ?? null,
        key: `l${i}`,
      });
      cursor = m.end;
    });
    if (cursor < content.length) {
      out.push({ kind: "text", text: content.slice(cursor), key: "t-tail" });
    }
    return out;
  }, [content, notes, cards, projectId, workspaceId]);

  if (!segments) {
    return <p className="whitespace-pre-wrap break-words line-clamp-2 m-0">{content}</p>;
  }

  return (
    // Buttons past the second line are tab-reachable: release the clamp while
    // focus is inside so keyboard users never focus a fully hidden control.
    <p className="whitespace-pre-wrap break-words line-clamp-2 focus-within:line-clamp-none m-0">
      {segments.map((seg) => {
        if (seg.kind === "text") return <React.Fragment key={seg.key}>{seg.text}</React.Fragment>;
        const targetId = seg.noteId ?? seg.cardId;
        if (!targetId) {
          return (
            <span
              key={seg.key}
              title={`Note not found: ${seg.title}`}
              className="text-[var(--text-tertiary)] opacity-70"
            >
              {`[[${seg.title}]]`}
            </span>
          );
        }
        const isNote = seg.noteId != null;
        return (
          <Tooltip key={seg.key} content={isNote ? `Open note: ${seg.title}` : `Open task: ${seg.title}`}>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (seg.noteId) revealNote(setView, seg.noteId);
                else if (seg.cardId) revealCard(setView, seg.cardId);
              }}
              className="inline-flex items-center px-1 rounded font-medium text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] transition-colors"
            >
              {seg.title}
            </button>
          </Tooltip>
        );
      })}
    </p>
  );
}

/**
 * Memoized: lives inside list items that re-render for reasons unrelated to
 * their content (dnd-kit context ticks, hydration). Props are primitives, and
 * the segment derivation above is a cheap regex scan, so re-renders stay cheap
 * even when the store subscription fires.
 */
export const CardDescriptionPreview = React.memo(CardDescriptionPreviewImpl);
