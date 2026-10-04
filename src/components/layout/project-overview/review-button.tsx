"use client";

import { NotebookPen } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { revealNote } from "@/lib/events";
import { Tooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown";
import { buildReview } from "../../../../shared/overview/review";
import type { Project } from "@/types";

/** Folder the generated reviews land in, so they don't clutter the notes root. */
export const REVIEWS_FOLDER = "Reviews";

/**
 * Overview header action: generate a weekly review or daily brief as a regular
 * markdown note (shipped / at risk / up next / notes touched) and open it.
 */
export function ReviewButton({ project }: { project: Project }) {
  const { cards, notes, getProjectColumns, createNote, setView } = useCairnStore(useShallow((s) => ({
    cards: s.cards,
    notes: s.notes,
    getProjectColumns: s.getProjectColumns,
    createNote: s.createNote,
    setView: s.setView,
  })));

  const generate = (days: number) => {
    const { title, content } = buildReview({
      projectName: project.name,
      cards: cards.filter((c) => c.projectId === project.id),
      columns: getProjectColumns(project.id),
      notes: notes.filter((n) => n.projectId === project.id && n.folder !== REVIEWS_FOLDER),
      days,
    });
    // Same-day reruns get a suffix so wikilinks to each review stay unambiguous.
    const taken = new Set(notes.filter((n) => n.projectId === project.id).map((n) => n.title.toLowerCase()));
    let unique = title;
    for (let i = 2; taken.has(unique.toLowerCase()); i++) unique = `${title} (${i})`;
    const note = createNote(project.id, unique, "note", REVIEWS_FOLDER, content);
    revealNote(setView, note.id);
  };

  return (
    <DropdownMenu>
      <Tooltip content="Weekly review / daily brief" side="bottom">
        <DropdownMenuTrigger asChild>
          <button
            className="p-1.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
            aria-label="Generate review note"
          >
            <NotebookPen size={14} />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => generate(7)}>Weekly review note</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => generate(1)}>Daily brief note</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
