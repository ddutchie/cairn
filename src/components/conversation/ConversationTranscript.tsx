"use client";

import React from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

interface ConversationTranscriptProps<T> {
  data: T[];
  transcriptRef?: React.RefObject<VirtuosoHandle | null>;
  /** Where a freshly mounted transcript starts. Defaults to the top; pass `{ index: "LAST", align: "end" }` to open at the newest message and render upward. */
  initialTopMostItemIndex?: number | { index: number | "LAST"; align?: "start" | "center" | "end" };
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
      // Unmeasured rows are estimated at this height until they render, so the
      // rows above the viewport don't reshuffle the scroll position as they load.
      defaultItemHeight={120}
      increaseViewportBy={{ top: 600, bottom: 200 }}
      followOutput={(isAtBottom) => (isAtBottom ? "smooth" : false)}
      components={{
        EmptyPlaceholder,
        ...(Footer ? { Footer } : {}),
      }}
      itemContent={itemContent}
    />
  );
}
