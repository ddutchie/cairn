"use client";

import * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * <ModalShell> — shared chrome for modal dialogs.
 *
 * Wraps the Radix Dialog primitive with the common patterns used across Cairn's
 * modals: open/onClose binding, size, optional icon-in-title, sr-only description
 * (for a11y), scrollable body, and optional footer.
 *
 * Extracted in P3-1 of the cleanup plan. 6 of 8 modals share this pattern;
 * `MigrationModal` (blocking, non-dismissible) and `card-detail` (VisuallyHidden
 * title, two-column body) are structurally different and stay bespoke.
 */

export interface ModalShellProps {
  /** Visibility state. When omitted, defaults to `true` (always-open until `onClose`). */
  open?: boolean;
  /** Called when the dialog should close (Escape, outside-click, or close-X). */
  onClose: () => void;
  /** Returns `false` to block dismissal (e.g. while a stream is in-flight). */
  dismissGuard?: () => boolean;
  /** Size preset passed to `<DialogContent>`. Default "md". */
  size?: "sm" | "md" | "lg" | "xl" | "full";
  /** Title text (rendered inside `<DialogTitle>`). Pass ReactNode for icon + text. */
  title?: React.ReactNode;
  /** Accessible description — rendered as sr-only text, auto-wired via `aria-describedby`. */
  description?: string;
  /** When `true`, content becomes a flex column with `max-h-[80vh]` and a scrollable body. */
  scrollable?: boolean;
  /** Optional footer row (actions, confirmation buttons, etc.). */
  footer?: React.ReactNode;
  /** Dialog content className override (for edge cases not covered by `size`/`scrollable`). */
  contentClassName?: string;
  children: React.ReactNode;
}

export function ModalShell({
  open = true,
  onClose,
  dismissGuard,
  size = "md",
  title,
  description,
  scrollable = false,
  footer,
  contentClassName,
  children,
}: ModalShellProps) {
  const handleOpenChange = (o: boolean) => {
    if (!o) {
      if (!dismissGuard || dismissGuard()) {
        onClose();
      }
    }
  };

  // Auto-generate a stable ID for the sr-only description.
  const descId = React.useId();

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        size={size}
        aria-describedby={description ? descId : undefined}
        className={
          scrollable
            ? `flex flex-col max-h-[80vh] overflow-hidden p-0 gap-0 ${contentClassName ?? ""}`
            : contentClassName
        }
      >
        {title && (
          <DialogHeader className={scrollable ? "px-5 py-4" : undefined}>
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              {title}
            </DialogTitle>
          </DialogHeader>
        )}
        {description && (
          <div id={descId} className="sr-only">
            {description}
          </div>
        )}
        <div className={scrollable ? "flex-1 overflow-y-auto px-5 py-4" : undefined}>
          {children}
        </div>
        {footer && (
          <div className={scrollable ? "px-5 py-4 border-t border-[var(--border-subtle)] flex justify-end gap-2" : undefined}>
            {footer}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
