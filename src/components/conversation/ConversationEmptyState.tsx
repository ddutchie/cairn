"use client";

import type { ReactNode } from "react";

interface ConversationEmptyStateProps {
  title?: string;
  description?: string;
  content?: ReactNode;
  children?: ReactNode;
}

/** Shared empty-session geometry; callers provide only session-specific copy/content. */
export function ConversationEmptyState({ title, description, content, children }: ConversationEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4 py-3 max-w-3xl mx-auto w-full">
      {content ?? (
        <>
          {title && <p className="text-[0.786rem] font-medium text-[var(--text-secondary)]">{title}</p>}
          {description && <p className="text-[0.714rem] text-[var(--text-tertiary)] max-w-48">{description}</p>}
          {children}
        </>
      )}
    </div>
  );
}
