"use client";

import * as React from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

interface DialogContentProps extends RadixDialog.DialogContentProps {
  size?: "sm" | "md" | "lg" | "xl" | "full";
}

export function DialogContent({
  className,
  children,
  size = "md",
  ...props
}: DialogContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-fade-in" />
      <RadixDialog.Content
        className={cn(
          "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50",
          "bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl",
          "focus:outline-none animate-slide-in-up",
          size === "sm" && "w-full max-w-sm",
          size === "md" && "w-full max-w-lg",
          size === "lg" && "w-full max-w-2xl",
          size === "xl" && "w-full max-w-4xl",
          size === "full" && "w-[calc(100vw-48px)] h-[calc(100vh-48px)] max-w-none",
          className
        )}
        {...props}
      >
        {children}
        <RadixDialog.Close
          className={cn(
            "absolute right-3 top-3 rounded-md p-1",
            "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]",
            "hover:bg-[var(--surface-2)] transition-colors"
          )}
        >
          <X size={14} />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export function DialogHeader({ className, children }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-5 pt-5 pb-3 border-b border-[var(--border-subtle)]", className)}>
      {children}
    </div>
  );
}

export function DialogTitle({ className, children, ...props }: RadixDialog.DialogTitleProps) {
  return (
    <RadixDialog.Title
      className={cn("text-sm font-semibold text-[var(--text-primary)]", className)}
      {...props}
    >
      {children}
    </RadixDialog.Title>
  );
}
