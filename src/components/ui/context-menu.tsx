"use client";

import * as React from "react";
import * as RadixContextMenu from "@radix-ui/react-context-menu";
import { cn } from "@/lib/utils";

export const ContextMenu = RadixContextMenu.Root;
export const ContextMenuTrigger = RadixContextMenu.Trigger;
export const ContextMenuPortal = RadixContextMenu.Portal;

export function ContextMenuContent({
  className,
  children,
  ...props
}: RadixContextMenu.ContextMenuContentProps) {
  return (
    <RadixContextMenu.Portal>
      <RadixContextMenu.Content
        className={cn(
          "z-50 min-w-[160px] rounded-lg p-1",
          "bg-[var(--surface-2)] border border-[var(--border)] shadow-2xl",
          "animate-fade-in",
          className
        )}
        {...props}
      >
        {children}
      </RadixContextMenu.Content>
    </RadixContextMenu.Portal>
  );
}

export function ContextMenuItem({
  className,
  children,
  ...props
}: RadixContextMenu.ContextMenuItemProps) {
  return (
    <RadixContextMenu.Item
      className={cn(
        "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm cursor-pointer",
        "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
        "hover:bg-[var(--surface-3)] focus:outline-none",
        "transition-colors duration-100",
        className
      )}
      {...props}
    >
      {children}
    </RadixContextMenu.Item>
  );
}

export function ContextMenuSeparator() {
  return <RadixContextMenu.Separator className="my-1 h-px bg-[var(--border)]" />;
}

export function ContextMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 py-1.5 text-xs text-[var(--text-tertiary)] font-medium uppercase tracking-wide">
      {children}
    </div>
  );
}
