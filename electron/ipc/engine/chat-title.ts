/**
 * Name a chat thread with the chat's own model after its first reply, the way
 * Claude and OpenCode do, instead of showing the first line of the prompt.
 * Best effort and off the turn's path: on any failure the first-line title stays.
 * The request is its own one-shot call, so the session's cached prefix is untouched.
 */
import { runOneShot } from "../../agent/one-shot";
import type { LLMConfig } from "../../lib/llm";
import type { AgentHost } from "../../agent/host";
import { cleanTitle, titleRequest, TITLE_SYSTEM_PROMPT } from "../../../shared/chat/title";

const TITLE_TIMEOUT_MS = 20_000;
/** Room for a reasoning model to think before it writes six words. */
const TITLE_MAX_TOKENS = 512;

const inFlight = new Set<string>();

export async function maybeTitleChat(
  host: Pick<AgentHost, "titleInputs" | "autoTitle">,
  sessionId: string,
  config: LLMConfig,
  ids: { workspaceId?: string; projectId?: string; cwd?: string },
  run: typeof runOneShot = runOneShot,
): Promise<string | undefined> {
  if (inFlight.has(sessionId)) return undefined;
  inFlight.add(sessionId);
  try {
    const userPrompt = titleRequest(await host.titleInputs(sessionId, ids.cwd));
    if (!userPrompt) return undefined;
    const raw = await run({
      systemPrompt: TITLE_SYSTEM_PROMPT,
      userPrompt,
      config,
      source: "chat-title",
      sessionId,
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      maxTokens: TITLE_MAX_TOKENS,
      temperature: 0.2,
      signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
    });
    const title = cleanTitle(raw);
    if (!title) return undefined;
    return (await host.autoTitle(sessionId, title, ids.cwd)) ? title : undefined;
  } finally {
    inFlight.delete(sessionId);
  }
}
