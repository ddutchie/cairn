"use client";

import React, { useCallback, useEffect, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { createBottomFollower, type BottomFollower } from "./bottom-follower";

interface ConversationTranscriptProps<T> {
  data: T[];
  /** Changes when the user sends a message, which brings the transcript back to the end. */
  sentCount?: number;
  transcriptRef?: React.RefObject<VirtuosoHandle | null>;
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
    // The viewport shrinks when the composer grows, which leaves the end out of view.
    const resize = new ResizeObserver(() => follower.contentChanged());
    resize.observe(el);
    cleanupRef.current = () => { observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame); follower.detach(); };
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
      // A transcript opens at its newest message, which is also where it follows from.
      initialTopMostItemIndex={{ index: "LAST", align: "end" }}
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
