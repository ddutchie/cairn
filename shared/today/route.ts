/**
 * Where a Today item goes when the user acts on it, and which connector tools
 * could send it there.
 *
 * Connector tools carry no reliable read-only or "sends" flag in Cairn yet, so
 * both the Today read-only gate (`electron/lib/today.ts`) and the act panel's
 * send check read the operation name. The verb lists live here so the two
 * agree. Pure: importable from renderer, main and tests.
 */

/** Operation verbs that change state on the far side. Checked before the read verbs. */
export const WRITE_VERB = /(^|_|-)(send|post|create|update|delete|remove|add|set|write|edit|move|archive|reply|react|invite|schedule|transition|assign|upload|publish|cancel|accept|decline|mark|merge|close|approve|comment|patch|put|rename|share|forward|execute|run|resolve|reopen|complete|submit|respond|rsvp|dismiss|snooze|mute|unmute|block|unblock|pin|unpin|star|unstar|like|vote|untag|subscribe|unsubscribe|join|leave|kick|ban|grant|revoke|enable|disable|restart|trigger|deploy|rollback|revert|insert|upsert|replace|save|import|sync|clear|reset|purge|restore|unlink|attach|detach|transfer|pay|charge|refund|reserve|push|append|apply|kill|notify|ping|copy|fork|dispatch|invoke|launch|spawn|wipe|drop|truncate|overwrite|destroy|terminate|suspend|activate|deactivate|reject|escalate|nudge|remind|broadcast|tweet|upvote|downvote|follow|unfollow|bookmark|lock|unlock|squash|rebase|buy|sell)(_|-|$)/i;
export const READ_VERB = /(^|_|-)(get|list|search|read|fetch|find|query|lookup|view|show|describe|retrieve|ask|summari[sz]e|browse|whoami|me|info|status|history|recent|my)(_|-|$)/i;
/** Verbs that deliver a message somewhere: the act panel's "can send" check. */
const SEND_VERB = /(^|_|-)(send|post|reply|forward|comment|respond)(_|-|$)/i;

/** `mcp__server__opName` → `op_name`, the words the verb checks read. */
export function operationWords(name: string): string {
  const parts = name.split("__");
  const op = parts.length >= 3 ? parts.slice(2).join("__") : name;
  return op.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
}

/**
 * Does an operation change something? Words in verb position decide: the first word, and any word
 * after "and" / "then" (`get_and_resolve`). A name that starts with a read verb is a read whatever
 * nouns follow (`get_post`, `list_comments`). Any other name is a write if it holds a write verb
 * anywhere (`message_send`), so an unusual name errs on the side of a write.
 */
export function isWriteOperation(op: string): boolean {
  const words = op.toLowerCase().split(/[_-]+/).filter(Boolean);
  if (!words.length) return false;
  const verb = (w: string | undefined) => !!w && WRITE_VERB.test(w);
  if (verb(words[0])) return true;
  for (let i = 1; i < words.length - 1; i++) if ((words[i] === "and" || words[i] === "then") && verb(words[i + 1])) return true;
  if (READ_VERB.test(words[0])) return false;
  return WRITE_VERB.test(op);
}

/**
 * Connector operations that reach the open web (a web search, a page fetch, a browser). A query to
 * one can carry text from what a run read to a service outside the user's apps.
 */
const WEB_WORD = /(^|_|-)(web|internet|google|bing|brave|duckduckgo|ddg|serp|serper|tavily|perplexity|exa|browse|browser|crawl|scrape|url|http|https)(_|-|$)/i;

export function isWebOperation(op: string): boolean {
  return WEB_WORD.test(op);
}

/** A connector whose name says it searches or browses the web ("Brave Web Search", "Tavily"). */
export function looksLikeWebApp(name: string): boolean {
  return /\b(web|internet|google search|bing|brave|duckduckgo|serp|serper|tavily|perplexity|exa|browser|crawler)\b/i.test(name);
}

/** The server part of a connector tool name (`mcp__slack__post` → `slack`). */
export function toolServer(name: string): string {
  const parts = name.split("__");
  return parts.length >= 3 ? parts[1] : "";
}

export type TodayChannel = "email" | "slack" | "teams" | "github" | "jira" | "confluence" | "board" | "other";

const CHANNEL_WORDS: Record<Exclude<TodayChannel, "board" | "other">, RegExp> = {
  email: /mail|outlook|gmail|inbox/i,
  slack: /slack/i,
  teams: /teams/i,
  github: /github|pull request|\bpr\b/i,
  jira: /jira/i,
  confluence: /confluence/i,
};

const CHANNEL_LABEL: Record<TodayChannel, string> = {
  email: "email", slack: "Slack", teams: "Teams", github: "GitHub", jira: "Jira", confluence: "Confluence", board: "the Cairn board", other: "its source",
};

/** Where an item came from, read from its `source` and `target` text ("Outlook via Work IQ" → email). */
export function channelFor(source: string, target?: string, kind?: string): TodayChannel {
  if (kind === "cards") return "board";
  const text = `${target ?? ""} ${source}`;
  for (const [channel, re] of Object.entries(CHANNEL_WORDS) as Array<[TodayChannel, RegExp]>) {
    if (re.test(text)) return channel;
  }
  if (/board|cairn|card|note/i.test(text)) return "board";
  return "other";
}

export function channelLabel(channel: TodayChannel): string {
  return CHANNEL_LABEL[channel];
}

export interface TodaySendTool {
  /** Full tool name the model calls (`mcp__slack__slack_post_message`). */
  name: string;
  server: string;
  /** Operation words, for display (`slack_post_message`). */
  op: string;
  description?: string;
}

/**
 * Connector tools that could deliver a reply on `channel`, best first: a send
 * verb in the operation, and the channel named in the server, operation or
 * description. For "other", any send-like tool counts; for the board, none
 * (Cairn's own tools write cards and notes).
 */
export function sendCandidates(
  defs: Array<{ name: string; description?: string }>, channel: TodayChannel,
  /** Server id → display name. Tool names carry the id (`mcp__WF1vubI3qu52__…`), so the name is what says "Slack". */
  serverNames: Record<string, string> = {},
): TodaySendTool[] {
  if (channel === "board") return [];
  const words = channel === "other" ? null : CHANNEL_WORDS[channel];
  const scored = defs.flatMap((d) => {
    const op = operationWords(d.name);
    if (!SEND_VERB.test(op)) return [];
    const id = toolServer(d.name);
    const server = serverNames[id] ?? id;
    const inName = words ? words.test(server) || words.test(op) : true;
    const inDesc = words ? words.test(d.description ?? "") : true;
    if (!inName && !inDesc) return [];
    // Prefer replies over new messages, and a match in the name over one in the description.
    const score = (inName ? 2 : 0) + (/reply|respond/i.test(op) ? 1 : 0);
    return [{ tool: { name: d.name, server, op, description: d.description }, score }];
  });
  return scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).map((s) => s.tool);
}

/** `today:route` result. */
export interface TodayRoute {
  channel: TodayChannel;
  label: string;
  tools: TodaySendTool[];
  /** Set when the connectors could not be listed; the panel falls back to copy and open. */
  error?: string;
}
