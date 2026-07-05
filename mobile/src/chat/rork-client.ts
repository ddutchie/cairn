/**
 * Rork AI toolkit client (mobile, online-only).
 *
 * Rork is a simple endpoint — POST {base}/text/llm/ with { messages } and it
 * returns { completion: string }. It is NOT OpenAI-compatible and has no native
 * function-calling, but it reliably honours system prompts and returns
 * structured JSON when instructed. The agent loop (agent.ts) uses that to drive
 * a prompt-based tool protocol.
 */

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

const DEFAULT_BASE = "https://toolkit.rork.com";

function baseUrl(): string {
  // EXPO_PUBLIC_* env vars are inlined at build time and safe to read here.
  const fromEnv = process.env.EXPO_PUBLIC_TOOLKIT_URL;
  return (fromEnv && fromEnv.trim()) || DEFAULT_BASE;
}

/**
 * Send messages to Rork and return the completion string.
 * Throws on network/HTTP error (caller shows an offline/error hint).
 */
export async function rorkComplete(messages: ChatMsg[], signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${baseUrl()}/text/llm/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Rork request failed (${res.status})`);
  }
  const data = (await res.json()) as { completion?: string };
  return data.completion ?? "";
}
