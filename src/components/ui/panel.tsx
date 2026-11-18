"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { TiltCard } from "./tilt-card";

/** A raised surface for a block of reference content (feeds, summaries). */
export const SURFACE = "rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-elev-1 p-4";

/**
 * A data instrument (progress, flow, priority, health): a raised surface that
 * lifts and tilts toward the pointer. Reduced motion turns the tilt off.
 */
export function InstrumentCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <TiltCard
      className={cn("rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 md:p-[18px] min-w-0", className)}
      restShadow="var(--elev-1)"
      activeShadow="var(--elev-3)"
    >
      {children}
    </TiltCard>
  );
}

/**
 * The heading every Overview block shares: display face, a hairline rule
 * beneath, an optional quiet note, and an optional action on the right. It is
 * the same heading the Today lanes use (see docs/design-language.md).
 */
export function PanelHeading({ title, note, action, className }: {
  title: React.ReactNode;
  note?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline gap-2 pb-2 mb-3 border-b border-[var(--border-subtle)]", className)}>
      <h2 className="font-display text-base">{title}</h2>
      {note && <span className="text-2xs text-[var(--text-tertiary)] min-w-0 truncate">{note}</span>}
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  );
}
