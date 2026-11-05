"use client";

import React, { useCallback, useEffect, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { createBottomFollower, type BottomFollower } from "./bottom-follower";

interface ConversationTranscriptProps<T> {
  data: T[];
  /** Changes when the user sends a message, which brings the transcript back to the end. */
  sentCount?: number;
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
  sentCount = 0,
  transcriptRef,
  initialTopMostItemIndex = 0,
  emptyPlaceholder: EmptyPlaceholder,
  footer: Footer,
  itemContent,
  className,
}: ConversationTranscriptProps<T>) {
  const followerRef = useRef<BottomFollower | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Follow here rather than with Virtuoso's followOutput: that stops as soon as the
  // live reply in the footer grows past the end, and never starts again.
  const attachScroller = useCallback((el: HTMLElement | Window | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    followerRef.current = null;
    if (!(el instanceof HTMLElement)) return;
    const follower = createBottomFollower(el);
    followerRef.current = follower;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; follower.contentChanged(); });
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    cleanupRef.current = () => { observer.disconnect(); cancelAnimationFrame(frame); follower.detach(); };
  }, []);
  useEffect(() => () => cleanupRef.current?.(), []);

  const lastSent = useRef(sentCount);
  useEffect(() => {
    if (sentCount > lastSent.current) followerRef.current?.follow();
    lastSent.current = sentCount;
  }, [sentCount]);

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
      scrollerRef={attachScroller}
      totalListHeightChanged={() => followerRef.current?.contentChanged()}
      components={{
        EmptyPlaceholder,
        ...(Footer ? { Footer } : {}),
      }}
      itemContent={itemContent}
    />
  );
}
