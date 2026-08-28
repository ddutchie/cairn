"use client";

import React from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

interface ConversationTranscriptProps<T> {
  data: T[];
  transcriptRef?: React.RefObject<VirtuosoHandle | null>;
  initialTopMostItemIndex?: number;
  emptyPlaceholder: React.ComponentType<{ context: unknown }>;
  footer?: React.ComponentType<{ context: unknown }>;
  itemContent: (index: number, item: T) => React.ReactNode;
  className?: string;
}

/** Shared virtualized transcript shell for every Cairn conversation kind. */
export function ConversationTranscript<T>({
  data,
  transcriptRef,
  initialTopMostItemIndex = 0,
  emptyPlaceholder: EmptyPlaceholder,
  footer: Footer,
  itemContent,
  className,
}: ConversationTranscriptProps<T>) {
  return (
    <Virtuoso
      ref={transcriptRef}
      className={className}
      data={data}
      initialTopMostItemIndex={initialTopMostItemIndex}
      followOutput={(isAtBottom) => (isAtBottom ? "smooth" : false)}
      components={{
        EmptyPlaceholder,
        ...(Footer ? { Footer } : {}),
      }}
      itemContent={itemContent}
    />
  );
}
