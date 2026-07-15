/**
 * One-time chat bootstrap: read the on-device history a SINGLE time and derive
 * both the UI bubble list and the agent's persistent UIMessage conversation
 * from it.
 *
 * The chat screen seeds two independent structures from history — the rendered
 * `messages` bubbles and the `conversation` ref the agent appends to across
 * turns. Doing that inline read `loadChatHistory()` twice (once per seed) on
 * every mount, re-parsing the same rows and their JSON blobs. This collapses it
 * to one read whose result feeds both, so history is loaded exactly once.
 */

import { loadChatHistory } from "@/db/chat-store";
import { userMessage, assistantMessage } from "./agent";
import type { UIMessage } from "./providers/types";

/** A UI chat bubble as the screen renders it (session-only fields added later). */
export interface UiMessage {
  role: "user" | "assistant";
  content: string;
  images?: string[];
  tools?: import("@/db/chat-store").ToolCall[];
  reasoning?: string;
  streaming?: boolean;
}

export interface InitialChat {
  /** UI bubbles to seed `messages` state. */
  uiMessages: UiMessage[];
  /** The agent's persistent conversation (system prompt is prepended at run). */
  conversation: UIMessage[];
}

/**
 * Load persisted chat history once and shape it for both consumers. Restores
 * user image attachments into the agent conversation so multimodal context
 * survives an app relaunch (the UI bubble shows them via `images`).
 */
export function loadInitialChat(): InitialChat {
  const history = loadChatHistory();
  const uiMessages: UiMessage[] = history.map((h) => ({
    role: h.role,
    content: h.content,
    images: h.images,
    tools: h.tools,
  }));
  const conversation: UIMessage[] = history.map((h) => {
    if (h.role === "user") {
      const atts = (h.images ?? []).map((url) => ({
        url,
        mediaType: url.match(/^data:([^;,]+)/)?.[1] ?? "image/jpeg",
      }));
      return userMessage(h.content, atts);
    }
    return assistantMessage(h.content);
  });
  return { uiMessages, conversation };
}
