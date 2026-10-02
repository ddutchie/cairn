"use client";

import * as React from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

export const TooltipProvider = RadixTooltip.Provider;

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  delayDuration?: number;
  /** Suppress the tooltip (e.g. while the trigger's own menu is open). */
  disabled?: boolean;
}

export function Tooltip({ content, children, side = "top", delayDuration = 400, disabled = false }: TooltipProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <RadixTooltip.Root delayDuration={delayDuration} open={open && !disabled} onOpenChange={setOpen}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className={cn(
            "z-50 rounded-md px-2.5 py-1 text-xs font-medium",
            "bg-[var(--surface-3)] text-[var(--text-primary)]",
            "border border-[var(--border)] shadow-lg",
            "animate-fade-in"
          )}
        >
          {content}
          <RadixTooltip.Arrow className="fill-[var(--surface-3)]" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
