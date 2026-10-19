"use client";

import { createContext, useContext } from "react";

/** Sends an A2UI surface action back into the conversation as a user message.
 *  Provided by ConversationPane; absent (null) in read-only transcripts. */
export type A2uiActionSender = (text: string) => void;

const A2uiActionContext = createContext<A2uiActionSender | null>(null);

export const A2uiActionProvider = A2uiActionContext.Provider;
export const useA2uiActionSender = () => useContext(A2uiActionContext);

/** One-line, model-readable rendering of a surface action. */
export function formatA2uiAction(a: { name?: string; context?: unknown; surfaceId?: string }): string {
  const ctx = a.context && typeof a.context === "object" && Object.keys(a.context).length > 0
    ? ` ${JSON.stringify(a.context)}`
    : "";
  return `[UI action] ${a.name ?? "action"}${ctx}`;
}
