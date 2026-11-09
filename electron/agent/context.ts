/**
 * The model view. The session log is complete and append-only; what the model
 * sees is derived from it: a `compaction` event replaces everything but the
 * last `keepCount` messages with a summary, and old bulky tool output is
 * pruned at request time. Nothing here mutates or deletes logged data.
 */
import type { Api, AssistantMessage, Message, Model, SimpleStreamOptions, Tool, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { COMPACTION_THRESHOLD_RATIO } from "../../shared/models/model-catalog";
import type { AgentEvent, UserImage } from "./events";
import { repairInterrupted } from "./repair";
import type { StreamFn } from "./loop";

export type CompactionEvent = Extract<AgentEvent, { type: "compaction" }>;
export type CompactionTrigger = CompactionEvent["trigger"];

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1200;
export const SUMMARY_PREFIX = "[Summary of the earlier conversation]\n";

// ── token estimates ──────────────────────────────────────────────────────

type Block = { type: string; text?: string };
const blocksOf = (c: string | readonly Block[]): readonly Block[] => (typeof c === "string" ? [{ type: "text", text: c }] : c);
const plain = (c: string | readonly Block[]): string => blocksOf(c).map((b) => (b.type === "text" ? b.text ?? "" : "[image]")).join("");

export function estimateTokens(message: Message): number {
  let chars = 0;
  let extra = 0;
  if (message.role === "assistant") {
    for (const b of message.content) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "thinking") chars += b.thinking.length;
      else chars += b.name.length + JSON.stringify(b.arguments).length;
    }
  } else {
    for (const b of blocksOf(message.content)) {
      if (b.type === "text") chars += b.text?.length ?? 0;
      else extra += IMAGE_TOKENS;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + extra;
}

export const estimateAll = (messages: readonly Message[]): number => messages.reduce((n, m) => n + estimateTokens(m), 0);

/** Token count at which to compact: 80% of the message budget (window minus reserved output). */
export function compactionThreshold(contextWindow: number, maxTokens: number): number | undefined {
  if (!(contextWindow > 0) || maxTokens >= contextWindow) return undefined;
  return Math.floor(COMPACTION_THRESHOLD_RATIO * (contextWindow - Math.max(0, maxTokens)));
}

// ── user content ─────────────────────────────────────────────────────────

/** Text alone stays a string; attached images make it a block list. */
export function userContent(text: string, images?: readonly UserImage[]): UserMessage["content"] {
  if (!images?.length) return text;
  return [{ type: "text", text }, ...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mediaType }))];
}

/** The prompt as the model sees it: what the user typed, then any model-only context. */
export const withContext = (text: string, context?: string): string => (context ? `${text}\n\n${context}` : text);

// ── derived view ─────────────────────────────────────────────────────────

export function summaryMessage(summary: string, timestamp: number): Message {
  return { role: "user", content: `${SUMMARY_PREFIX}${summary}`, timestamp };
}

export const isSummaryMessage = (m: Message): boolean => m.role === "user" && typeof m.content === "string" && m.content.startsWith(SUMMARY_PREFIX);

/** Apply a compaction to a message list: summary + the last `keepCount` messages. */
export function applyCompaction(messages: readonly Message[], c: Pick<CompactionEvent, "summary" | "keepCount">, timestamp = Date.now()): Message[] {
  const keep = c.keepCount > 0 ? messages.slice(-c.keepCount) : [];
  return [summaryMessage(c.summary, timestamp), ...keep];
}

/**
 * Provider history from log events. Mirrors the loop exactly — repair at each
 * turn start, compaction as logged — so `keepCount` means the same thing live
 * and on replay.
 */
export function buildContextView(records: ReadonlyArray<{ event: AgentEvent; time: number }>, now?: number): Message[] {
  let messages: Message[] = [];
  const answered = new Set<string>();
  for (const { event, time } of records) {
    switch (event.type) {
      case "turn/start": messages = repairInterrupted(messages, time); break;
      case "user/message": if (event.blocked) break; messages.push({ role: "user", content: userContent(withContext(event.content, event.context), event.images), timestamp: time }); break;
      case "assistant/message": messages.push(event.message); break;
      case "tool/result":
        // Logs imported before the importer dropped repeats still hold them; providers reject a result with no call to answer.
        if (answered.has(event.callId)) break;
        answered.add(event.callId);
        messages.push({ role: "toolResult", toolCallId: event.callId, toolName: event.name, content: [{ type: "text", text: event.text }], isError: event.isError, timestamp: time });
        break;
      case "compaction": messages = applyCompaction(messages, event, time); break;
      default: break;
    }
  }
  return repairInterrupted(messages, now);
}

// ── request-time pruning ─────────────────────────────────────────────────
//
// Providers cache a request by its prefix, so a view that rewrites an old message costs a
// re-write of everything after it. Both pruners therefore measure from the START of the
// history (positions there never move while it only grows) and advance their cut in large
// steps: between steps the pruned prefix is byte-identical from one request to the next.

export interface PruneOptions {
  /** Newest tokens always left untouched. */
  protectTokens?: number;
  /** How far the cut moves each time it moves. Default: half of `protectTokens`. */
  stepTokens?: number;
  /** Only outputs at least this long are worth replacing. */
  minChars?: number;
}

/** Replace old, bulky tool output with a stub. Pure; returns the same objects when nothing changes. */
export function pruneToolResults(messages: readonly Message[], opts: PruneOptions = {}): Message[] {
  const protect = opts.protectTokens ?? 40_000;
  const step = Math.max(1, opts.stepTokens ?? Math.floor(protect / 2));
  const minChars = opts.minChars ?? 2_000;
  const out = messages.slice();
  const sizes = messages.map(estimateTokens);
  const total = sizes.reduce((n, t) => n + t, 0);
  // Everything that ends at or before `cut` tokens from the start is old enough to stub.
  const cut = Math.floor((total - protect) / step) * step;
  let end = 0;
  for (let i = 0; i < out.length; i++) {
    end += sizes[i];
    if (end > cut) break;
    const m = out[i];
    if (m.role !== "toolResult") continue;
    const chars = m.content.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0);
    const hasImage = m.content.some((b) => b.type === "image");
    if (chars >= minChars || hasImage) {
      out[i] = { ...m, content: [{ type: "text", text: `[tool output pruned: ${chars} chars${hasImage ? ", image" : ""}]` }] } satisfies ToolResultMessage;
    }
  }
  return out;
}

/**
 * Keep the newest images in the request and stub the rest, so a long conversation doesn't
 * resend every screenshot. Images are dropped a batch at a time (half of `keep`), so between
 * `keep` and `keep + batch - 1` stay. Pure; the log keeps them all.
 */
export function pruneImages(messages: readonly Message[], keep = 8, batch = Math.max(1, Math.floor(keep / 2))): Message[] {
  const hasImages = (m: Message) => m.role !== "assistant" && typeof m.content !== "string" && m.content.some((b) => b.type === "image");
  let total = 0;
  for (const m of messages) if (hasImages(m)) total += (m.content as Block[]).filter((b) => b.type === "image").length;
  let drop = Math.max(0, Math.floor((total - keep) / batch) * batch);
  const out = messages.slice();
  for (let i = 0; i < out.length && drop > 0; i++) {
    const m = out[i];
    if (!hasImages(m) || m.role === "assistant" || typeof m.content === "string") continue;
    const content = m.content.map((b) => {
      if (b.type !== "image" || drop <= 0) return b;
      drop--;
      return { type: "text" as const, text: "[earlier image omitted]" };
    });
    out[i] = { ...m, content } as Message;
  }
  return out;
}

// ── compaction ───────────────────────────────────────────────────────────

export interface CompactionPlan {
  /** Messages to summarize. */
  head: Message[];
  /** Trailing messages kept verbatim. */
  keepCount: number;
}

/**
 * Choose where to cut. The kept tail starts at a user or assistant message —
 * never a tool result — so a tool call and its results stay together.
 */
export function planCompaction(messages: readonly Message[], keepRecentTokens: number): CompactionPlan | undefined {
  let acc = 0;
  let cut = messages.length;
  while (cut > 0 && acc < keepRecentTokens) acc += estimateTokens(messages[--cut]);
  while (cut > 0 && messages[cut].role === "toolResult") cut--;
  // The summary itself counts as something to fold into the next summary, so cut >= 1 is enough.
  if (cut < 1) return undefined;
  return { head: messages.slice(0, cut), keepCount: messages.length - cut };
}

const SUMMARY_FORMAT = `Write a dense, factual summary in markdown with these sections (omit empty ones):
## Goal — what the user is trying to achieve
## Decisions & constraints — choices made, preferences, rules to keep following
## Progress — what has been done, including files, notes and tasks touched (with ids/paths)
## Open items — unfinished work and the immediate next step
## Key facts — names, ids, values the assistant will need again
If the conversation begins with an earlier summary, merge it into your result instead of repeating it. Never invent details. Do not address the user.`;

const SUMMARY_SYSTEM = `You compress a conversation between a user and an AI assistant so the assistant can continue it later.\n${SUMMARY_FORMAT}`;

/** The same request, asked at the end of the live conversation (see `CompactorOptions.live`). */
const SUMMARY_REQUEST = `<compaction_request>
Pause the task here. This conversation is about to be compressed so you can continue it later with less context: reply with a summary of everything above and nothing else. Do not call any tools and do not continue the work.
${SUMMARY_FORMAT}
</compaction_request>`;

const RESULT_CLIP = 1_500;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

/** Plain-text rendering of messages for the summarizer (no tool pairing to satisfy). */
export function renderTranscript(messages: readonly Message[]): string {
  return messages.map((m) => {
    if (m.role === "user") return `USER: ${plain(m.content)}`;
    if (m.role === "system") return `SYSTEM: ${plain(m.content)}`;
    if (m.role === "assistant") {
      return `ASSISTANT: ${m.content.map((b) => b.type === "text" ? b.text : b.type === "toolCall" ? `[called ${b.name} ${clip(JSON.stringify(b.arguments), 400)}]` : "").join("")}`.trimEnd();
    }
    return `TOOL RESULT (${m.toolName}${m.isError ? ", error" : ""}): ${clip(plain(m.content), RESULT_CLIP)}`;
  }).join("\n\n");
}

export interface CompactorOptions {
  model: Model<Api>;
  streamFn: StreamFn;
  signal?: AbortSignal;
  /** Tokens of recent conversation kept verbatim. Default: a quarter of the message budget, max 20k. */
  keepRecentTokens?: number;
  maxSummaryTokens?: number;
  /**
   * The conversation's own request shape. With it the summary is asked for at the end of the
   * conversation exactly as the last step sent it, so the provider reads the whole history from
   * its cache instead of being sent a re-rendered transcript at full price. Not used after an
   * overflow (that request is the one that didn't fit), and any failure falls back to the transcript.
   */
  live?: {
    systemPrompt?: string;
    tools: readonly Tool[];
    /** The same view of the history the loop sends (`transformContext`). */
    view?: (messages: Message[]) => Message[];
    streamOptions?: Omit<SimpleStreamOptions, "signal" | "maxTokens">;
  };
}

export interface CompactionResult {
  event: CompactionEvent;
  history: Message[];
}

const summaryTokens = (o: CompactorOptions): number => o.maxSummaryTokens ?? Math.min(4_096, o.model.maxTokens || 4_096);
const textOf = (m: AssistantMessage): string => m.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();

export async function summarize(head: readonly Message[], o: CompactorOptions): Promise<string> {
  const prompt = `Summarize this conversation:\n\n<conversation>\n${renderTranscript(head)}\n</conversation>`;
  const stream = o.streamFn(o.model, { systemPrompt: SUMMARY_SYSTEM, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, {
    signal: o.signal, maxTokens: summaryTokens(o),
  });
  for await (const ev of stream) void ev;
  const result: AssistantMessage = await stream.result();
  if (result.stopReason === "aborted") throw new Error("compaction aborted");
  if (result.stopReason === "error") throw new Error(result.errorMessage ?? "compaction request failed");
  const text = textOf(result);
  if (!text) throw new Error("compaction produced an empty summary");
  return text;
}

/**
 * Ask for the summary as the next message of the live conversation. Returns undefined when the
 * model didn't produce one (an error, a tool call, a cut-off or empty reply), so the caller can
 * fall back; only an abort throws.
 */
export async function summarizeLive(history: readonly Message[], o: CompactorOptions): Promise<string | undefined> {
  const live = o.live;
  if (!live) return undefined;
  const messages = [...history];
  const context = {
    systemPrompt: live.systemPrompt,
    messages: [...(live.view ? live.view(messages) : messages), { role: "user" as const, content: SUMMARY_REQUEST, timestamp: Date.now() }],
    tools: live.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
  };
  let result: AssistantMessage;
  try {
    const stream = o.streamFn(o.model, context, { ...live.streamOptions, signal: o.signal, maxTokens: summaryTokens(o) });
    for await (const ev of stream) void ev;
    result = await stream.result();
  } catch {
    if (o.signal?.aborted) throw new Error("compaction aborted");
    return undefined;
  }
  if (result.stopReason === "aborted") throw new Error("compaction aborted");
  if (result.stopReason !== "stop" || result.content.some((b) => b.type === "toolCall")) return undefined;
  return textOf(result) || undefined;
}

/** Compact a history. Returns undefined when there is nothing worth folding. */
export async function compactHistory(history: readonly Message[], trigger: CompactionTrigger, o: CompactorOptions): Promise<CompactionResult | undefined> {
  const budget = Math.max(0, o.model.contextWindow - (o.model.maxTokens || 0));
  const keepRecent = o.keepRecentTokens ?? Math.min(20_000, Math.floor(budget / 4));
  const plan = planCompaction(history, keepRecent);
  if (!plan) return undefined;
  // The live request covers the kept tail too, which the summary may then repeat; that is harmless.
  const summary = (trigger !== "overflow" ? await summarizeLive(history, o) : undefined) ?? await summarize(plan.head, o);
  const event: CompactionEvent = { type: "compaction", summary, keepCount: plan.keepCount, tokensBefore: estimateAll(history), trigger };
  return { event, history: applyCompaction(history, event) };
}
