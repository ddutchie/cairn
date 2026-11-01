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
  /** Classes for the wrapper a disabled trigger gets (e.g. `flex-1`). */
  wrapperClassName?: string;
}

export function Tooltip({ content, children, side = "top", delayDuration = 400, disabled = false, wrapperClassName }: TooltipProps) {
  const [open, setOpen] = React.useState(false);
  // A disabled button gets no pointer events, so the tooltip would never open
  // (unlike native `title=`). Hover a wrapper instead, which is often where
  // the hint matters most: it says why the control is disabled.
  const triggerDisabled =
    React.isValidElement<{ disabled?: boolean }>(children) && Boolean(children.props.disabled);
  return (
    <RadixTooltip.Root delayDuration={delayDuration} open={open && !disabled} onOpenChange={setOpen}>
      <RadixTooltip.Trigger asChild>
        {triggerDisabled ? (
          <span className={cn("inline-flex [&>:disabled]:pointer-events-none", wrapperClassName)}>{children}</span>
        ) : (
          children
        )}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className={cn(
            "z-50 rounded-md px-2.5 py-1 text-xs font-medium",
            "bg-[var(--surface-3)] text-[var(--text-primary)]",
            "border border-[var(--border)] shadow-elev-2",
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
