"use client";

import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { CardDetailBody } from "./card-detail-body";

interface CardDetailModalProps {
  cardId: string;
  onClose: () => void;
}

export function CardDetailModal({ cardId, onClose }: CardDetailModalProps) {
  const { card, project, column } = useCairnStore(useShallow((s) => {
    const card = s.cards.find((c) => c.id === cardId);
    return {
      card,
      project: card ? s.projects.find((p) => p.id === card.projectId) : undefined,
      column: card ? s.columns.find((c) => c.id === card.columnId) : undefined,
    };
  }));

  if (!card) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" className="flex flex-col max-h-[80vh]">
        <DialogHeader>
          <VisuallyHidden.Root>
            <DialogTitle>{card.title}</DialogTitle>
          </VisuallyHidden.Root>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-tertiary)]">
              {project?.name} / {column?.name}
            </span>
          </div>
        </DialogHeader>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          <CardDetailBody cardId={cardId} onClose={onClose} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
