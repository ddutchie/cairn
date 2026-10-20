"use client";

import * as React from "react";
import * as RadixContextMenu from "@radix-ui/react-context-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

export const ContextMenu = RadixContextMenu.Root;
export const ContextMenuTrigger = RadixContextMenu.Trigger;
export const ContextMenuPortal = RadixContextMenu.Portal;
export const ContextMenuSub = RadixContextMenu.Sub;
export const ContextMenuRadioGroup = RadixContextMenu.RadioGroup;

const surface = cn(
  "z-50 min-w-[160px] rounded-lg p-1",
  "bg-[var(--surface-2)] border border-[var(--border)] shadow-2xl",
  "animate-fade-in",
);

const itemBase = cn(
  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm cursor-pointer outline-none",
  "text-[var(--text-secondary)]",
  "hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]",
  "data-[highlighted]:bg-[var(--surface-3)] data-[highlighted]:text-[var(--text-primary)]",
  "data-[disabled]:opacity-40 data-[disabled]:pointer-events-none",
  "transition-colors duration-100",
);

export function ContextMenuContent({
  className,
  children,
  ...props
}: RadixContextMenu.ContextMenuContentProps) {
  return (
    <RadixContextMenu.Portal>
      {/* data-dialog-portal: lets the menu stay interactive over a modal
          (see globals.css [data-dialog-portal] / dialog.tsx outside-click). */}
      <RadixContextMenu.Content
        data-dialog-portal
        className={cn(surface, className)}
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
    <RadixContextMenu.Item className={cn(itemBase, className)} {...props}>
      {children}
    </RadixContextMenu.Item>
  );
}

export function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: RadixContextMenu.ContextMenuSubTriggerProps) {
  return (
    <RadixContextMenu.SubTrigger
      className={cn(itemBase, "data-[state=open]:bg-[var(--surface-3)] data-[state=open]:text-[var(--text-primary)]", className)}
      {...props}
    >
      {children}
      <ChevronRight size={12} className="ml-auto text-[var(--text-tertiary)]" aria-hidden />
    </RadixContextMenu.SubTrigger>
  );
}

export function ContextMenuSubContent({
  className,
  children,
  ...props
}: RadixContextMenu.ContextMenuSubContentProps) {
  return (
    <RadixContextMenu.Portal>
      <RadixContextMenu.SubContent
        data-dialog-portal
        className={cn(surface, "max-h-[60vh] overflow-y-auto", className)}
        {...props}
      >
        {children}
      </RadixContextMenu.SubContent>
    </RadixContextMenu.Portal>
  );
}

export function ContextMenuCheckboxItem({
  className,
  children,
  ...props
}: RadixContextMenu.ContextMenuCheckboxItemProps) {
  return (
    <RadixContextMenu.CheckboxItem className={cn(itemBase, className)} {...props}>
      <span className="w-3.5 flex items-center justify-center">
        <RadixContextMenu.ItemIndicator>
          <Check size={12} />
        </RadixContextMenu.ItemIndicator>
      </span>
      {children}
    </RadixContextMenu.CheckboxItem>
  );
}

export function ContextMenuRadioItem({
  className,
  children,
  ...props
}: RadixContextMenu.ContextMenuRadioItemProps) {
  return (
    <RadixContextMenu.RadioItem className={cn(itemBase, className)} {...props}>
      <span className="w-3.5 flex items-center justify-center">
        <RadixContextMenu.ItemIndicator>
          <Circle size={6} fill="currentColor" />
        </RadixContextMenu.ItemIndicator>
      </span>
      {children}
    </RadixContextMenu.RadioItem>
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

/** Red/danger item styling shared by every destructive entry. */
export const CONTEXT_MENU_DANGER = "text-[var(--danger)] hover:text-[var(--danger)] data-[highlighted]:text-[var(--danger)]";
