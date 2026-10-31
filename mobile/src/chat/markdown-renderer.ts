import { useSyncExternalStore } from "react";
import { getMeta, setMeta } from "@/db";

/** Which markdown renderer the chat bubbles use (the choice only exists in dev builds). `native` is react-native-streamdown; `classic` is the markdown-it `MarkdownView`. */
export type ChatRenderer = "native" | "classic";

const META_KEY = "chatMarkdownRenderer";
const DEFAULT_RENDERER: ChatRenderer = "native";

let current: ChatRenderer | null = null;
const listeners = new Set<() => void>();

function read(): ChatRenderer {
  try {
    const v = getMeta(META_KEY);
    return v === "classic" || v === "native" ? v : DEFAULT_RENDERER;
  } catch {
    return DEFAULT_RENDERER;
  }
}

export function getChatRenderer(): ChatRenderer {
  // The classic renderer is a dev-only fallback; releases always use native.
  if (!__DEV__) return DEFAULT_RENDERER;
  if (current === null) current = read();
  return current;
}

/** Persist + broadcast a new renderer. No-op if unchanged. */
export function setChatRenderer(next: ChatRenderer): void {
  if (getChatRenderer() === next) return;
  current = next;
  try {
    setMeta(META_KEY, next);
  } catch {
    // best-effort; the in-memory value still drives this session
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useChatRenderer(): ChatRenderer {
  return useSyncExternalStore(subscribe, getChatRenderer, getChatRenderer);
}
