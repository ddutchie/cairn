"use client";

/**
 * The page every People picture sits in: a scrolling column, a plain-language
 * lede and the content beneath it. One wrapper so Teams, Time zones, Rhythm,
 * Bridges and Map share padding, width and the `@container` that the narrow
 * layouts (the side panel opens beside them) key off.
 */
import React from "react";

export function PeopleCanvasPage({ lede, children }: { lede: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="@container h-full overflow-y-auto px-6 py-5">
      <div className="max-w-[1240px]">
        <p className="mb-7 max-w-[62ch] text-base leading-relaxed text-[var(--text-secondary)] text-pretty">{lede}</p>
        {children}
      </div>
    </div>
  );
}
