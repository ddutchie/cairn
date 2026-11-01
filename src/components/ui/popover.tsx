"use client";

import * as React from "react";
import * as RadixPopover from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";

/**
 * Popover for rich floating panels (a search box plus a list, a small form).
 * Same surface as DropdownMenuContent (portal, 6px offset, rounded-lg,
 * elevation 2) so menus and popovers read as one layer. Use DropdownMenu for
 * plain action lists and Combobox for searchable pickers.
 */
export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof RadixPopover.Content>,
  RadixPopover.PopoverContentProps & {
    /** Match the trigger's width (never narrower than `minWidth`). */
    matchTriggerWidth?: boolean;
  }
>(({ className, align = "start", sideOffset = 6, matchTriggerWidth = false, ...props }, ref) => (
  <RadixPopover.Portal>
    <RadixPopover.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      collisionPadding={8}
      data-dialog-portal
      className={cn(
        "z-50 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-elev-2 animate-fade-in focus:outline-none",
        matchTriggerWidth && "w-[var(--radix-popover-trigger-width)]",
        className,
      )}
      {...props}
    />
  </RadixPopover.Portal>
));

PopoverContent.displayName = "PopoverContent";
