"use client";

import { CardDetailBody } from "./card-detail-body";

interface CardDetailPanelProps {
  cardId: string;
  onClose?: () => void;
}

export function CardDetailPanel({ cardId, onClose }: CardDetailPanelProps) {
  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden bg-[var(--surface)] text-[var(--text-primary)]">
      <CardDetailBody
        cardId={cardId}
        onClose={onClose}
        showBreadcrumb
        descMinHeight="min-h-[10rem]"
        descRows={6}
      />
    </div>
  );
}
