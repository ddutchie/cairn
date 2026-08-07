"use client";

import * as React from "react";
import * as RadixDropdown from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export const DropdownMenu = RadixDropdown.Root;
export const DropdownMenuTrigger = RadixDropdown.Trigger;

export function DropdownMenuContent({
  className,
  children,
  onOpenAutoFocus,
  ...props
}: RadixDropdown.DropdownMenuContentProps & {
  // onOpenAutoFocus is implemented by Radix's Content at runtime but typed as a
  // private prop (stripped from the public content props). Re-expose it so
  // callers can focus a custom element (e.g. a search box) on open.
  onOpenAutoFocus?: (event: Event) => void;
}) {
  return (
    <RadixDropdown.Portal>
      <RadixDropdown.Content
        className={cn(
          "z-50 min-w-[160px] rounded-lg py-1",
          "bg-[var(--surface)] border border-[var(--border)] shadow-lg",
          "animate-fade-in",
          className
        )}
        sideOffset={6}
        {...(onOpenAutoFocus
          ? ({ onOpenAutoFocus } as Record<string, unknown>)
          : {})}
        {...props}
      >
        {children}
      </RadixDropdown.Content>
    </RadixDropdown.Portal>
  );
}

export function DropdownMenuItem({
  className,
  children,
  ...props
}: RadixDropdown.DropdownMenuItemProps) {
  return (
    <RadixDropdown.Item
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer",
        "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] data-[highlighted]:bg-[var(--surface-2)] data-[highlighted]:text-[var(--text-primary)]",
        "focus:outline-none transition-colors duration-100",
        className
      )}
      {...props}
    >
      {children}
    </RadixDropdown.Item>
  );
}

export function DropdownMenuSeparator() {
  return <RadixDropdown.Separator className="my-1 h-px bg-[var(--border)]" />;
}

export function DropdownMenuLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("px-2.5 py-1.5 text-xs text-[var(--text-tertiary)] font-medium uppercase tracking-wide", className)}>
      {children}
    </div>
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: RadixDropdown.DropdownMenuCheckboxItemProps) {
  return (
    <RadixDropdown.CheckboxItem
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer",
        "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] data-[highlighted]:bg-[var(--surface-2)] data-[highlighted]:text-[var(--text-primary)]",
        "focus:outline-none transition-colors duration-100",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="w-4 h-4 flex items-center justify-center">
        <RadixDropdown.ItemIndicator>
          <Check size={12} />
        </RadixDropdown.ItemIndicator>
      </span>
      {children}
    </RadixDropdown.CheckboxItem>
  );
}
