/**
 * Naming a chat thread: the prompt for a short title, and the cleanup of what
 * the model sends back. Pure, so desktop (and mobile, once it has threads) agree.
 */

/** Longest title kept, in characters. */
export const TITLE_MAX = 60;

/** How much of each message the title request carries. */
const EXCERPT_CHARS = 1200;

export const TITLE_SYSTEM_PROMPT = [
  "You name conversations. Reply with a title for the conversation below and nothing else.",
  "Rules: at most 6 words; say what the person wants, not that they asked; sentence case;",
  "no quotes, no emoji, no trailing punctuation; write in the language the person wrote in.",
  "Never answer the request itself.",
].join("\n");

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

/** The user prompt for the title request: the first message and the start of the reply. */
export function titleUserPrompt(firstMessage: string, firstReply?: string): string {
  const parts = [`<message>\n${excerpt(firstMessage)}\n</message>`];
  if (firstReply?.trim()) parts.push(`<reply>\n${excerpt(firstReply)}\n</reply>`);
  parts.push("Title:");
  return parts.join("\n\n");
}

/**
 * The model's reply as a title: its first non-empty line, without a "Title:"
 * label, markdown, wrapping quotes or trailing punctuation, capped at TITLE_MAX.
 * Returns undefined when nothing usable is left.
 */
export function cleanTitle(raw: string): string | undefined {
  // Reasoning models can leak a thinking block into the text.
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  let line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  line = line
    .replace(/^#+\s*/, "")
    .replace(/^(\*\*)?title(\*\*)?\s*:\s*/i, "")
    .replace(/^[*_`]+|[*_`]+$/g, "")
    .trim();
  // Strip one or more layers of wrapping quotes.
  for (let i = 0; i < 3; i++) {
    const m = /^["'“”‘’«»](.*)["'“”‘’«»]$/.exec(line);
    if (!m) break;
    line = m[1].trim();
  }
  line = line.replace(/[.。!?:;,\s]+$/u, "").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

/** A first message too thin to name a thread from ("hi", "help"): worth a second try after the next turn. */
export function isVagueMessage(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length < 4;
}

/** The session's state as far as naming goes (the engine folds it from the log). */
export interface TitleState {
  /** Prompts a person typed, oldest first. */
  humanMessages: readonly string[];
  firstReply?: string;
  /** Auto titles recorded so far. */
  autoTitles: number;
  /** A title a person set; auto titles never replace it. */
  userTitle?: string;
}

/**
 * Whether to ask the model for a title now, and with what: once after the first
 * reply, and once more after the second message when the first was too thin to
 * name ("hi"). Returns the user prompt, or undefined to leave the title alone.
 */
export function titleRequest(s: TitleState): string | undefined {
  if (s.userTitle) return undefined;
  const [first, second] = s.humanMessages;
  if (!first) return undefined;
  if (s.autoTitles === 0) {
    const message = isVagueMessage(first) && second ? `${first}\n${second}` : first;
    return titleUserPrompt(message, s.humanMessages.length === 1 ? s.firstReply : undefined);
  }
  if (s.autoTitles === 1 && s.humanMessages.length === 2 && isVagueMessage(first) && second) {
    return titleUserPrompt(`${first}\n${second}`);
  }
  return undefined;
}
