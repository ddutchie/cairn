/**
 * Prefilled GitHub "new issue" links for the per-message Report an issue action.
 *
 * Nothing is sent anywhere by Cairn: the link opens in the user's browser,
 * where they review and submit it themselves. GitHub rejects very long URLs
 * (~8K), so the assistant reply is trimmed to fit and the body says so.
 */

export const ISSUE_REPO = "ddutchie/cairn";
/** Conservative cap on the full URL length; GitHub 414s a little above 8K. */
export const ISSUE_URL_MAX = 7000;

/** Opt-in: what the user has connected. Names only, never URLs, headers or args. */
export interface IssueSetup {
  mcpServers: Array<{ name: string; enabled: boolean; tools?: number }>;
  /** Registered tools by source, for the surface the reply came from. */
  tools?: { total: number; bySource: Record<string, number> };
  skills: string[];
}

export interface IssueEnv {
  appVersion: string;
  platform: string;
  /** Which Cairn surface produced the reply. */
  surface?: "Chat" | "Coding agent";
  model?: string;
  contextWindow?: number;
  /** A number of tokens, or "Auto". */
  maxOutput?: number | "Auto";
  reasoningEffort?: string;
  /** Coding agent approval mode (e.g. "interactive", "auto"). */
  approvalMode?: string;
  /** Chat only: whether the subagent dispatcher is on. */
  subagents?: boolean;
  /** This turn's measured stats. */
  turn?: { ttftMs?: number; tokensPerSecond?: number; outputTokens?: number };
  toolCalls?: { total: number; failed: number; failedNames: string[] };
  setup?: IssueSetup;
}

export interface IssueDraft {
  title: string;
  notes: string;
  /** The assistant reply, when the user opted to include it. */
  reply?: string;
  env: IssueEnv;
}

function fence(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

const num = (n: number) => n.toLocaleString("en-US");

function envLines(env: IssueEnv): string[] {
  const lines = [`- Cairn: v${env.appVersion}`, `- OS: ${env.platform}`];
  if (env.surface) lines.push(`- Surface: ${env.surface}`);
  if (env.model) lines.push(`- Model: ${env.model}`);
  if (env.contextWindow) lines.push(`- Context window: ${num(env.contextWindow)} tokens`);
  if (env.maxOutput !== undefined) {
    lines.push(`- Max output: ${typeof env.maxOutput === "number" ? `${num(env.maxOutput)} tokens` : env.maxOutput}`);
  }
  if (env.reasoningEffort) lines.push(`- Reasoning effort: ${env.reasoningEffort}`);
  if (env.approvalMode) lines.push(`- Approval mode: ${env.approvalMode}`);
  if (env.subagents !== undefined) lines.push(`- Subagents: ${env.subagents ? "on" : "off"}`);
  const t = env.turn;
  if (t) {
    const bits = [
      t.ttftMs !== undefined ? `first token ${num(Math.round(t.ttftMs))} ms` : "",
      t.tokensPerSecond !== undefined ? `${t.tokensPerSecond.toFixed(1)} tok/s` : "",
      t.outputTokens !== undefined ? `${num(t.outputTokens)} output tokens` : "",
    ].filter(Boolean);
    if (bits.length) lines.push(`- This turn: ${bits.join(", ")}`);
  }
  const c = env.toolCalls;
  if (c && c.total > 0) {
    lines.push(`- Tool calls: ${c.total}${c.failed ? `, ${c.failed} failed${c.failedNames.length ? ` (${c.failedNames.join(", ")})` : ""}` : ""}`);
  }
  const s = env.setup;
  if (s) {
    const servers = s.mcpServers.map(
      (m) => `${m.name} (${m.enabled ? "enabled" : "disabled"}${m.tools !== undefined ? `, ${m.tools} tools` : ""})`,
    );
    lines.push(`- MCP servers: ${servers.length ? servers.join(", ") : "none"}`);
    if (s.tools) {
      const src = Object.entries(s.tools.bySource).map(([k, v]) => `${k} ${v}`).join(", ");
      lines.push(`- Tools registered: ${s.tools.total}${src ? ` (${src})` : ""}`);
    }
    const shown = s.skills.slice(0, 20);
    lines.push(`- Skills: ${shown.length ? shown.join(", ") + (s.skills.length > shown.length ? `, +${s.skills.length - shown.length} more` : "") : "none"}`);
  }
  return lines;
}

export function buildIssueBody(draft: IssueDraft, replyTruncated = false): string {
  const parts = [
    "## What went wrong",
    draft.notes.trim() || "_Describe the problem here._",
    "",
    "## Environment",
    ...envLines(draft.env),
  ];
  if (draft.reply?.trim()) {
    const reply = draft.reply.trim();
    const f = fence(reply);
    parts.push(
      "",
      "<details>",
      `<summary>Assistant reply${replyTruncated ? " (truncated)" : ""}</summary>`,
      "",
      f,
      reply,
      f,
      "",
      "</details>",
    );
  }
  return parts.join("\n");
}

function toUrl(title: string, body: string): string {
  const q = new URLSearchParams({ title, body });
  return `https://github.com/${ISSUE_REPO}/issues/new?${q.toString()}`;
}

/** Builds the link, trimming the reply (then the notes) until it fits. */
export function buildIssueUrl(draft: IssueDraft): { url: string; truncated: boolean } {
  const title = draft.title.trim() || "Issue with an assistant reply";
  let reply = draft.reply?.trim() ?? "";
  let notes = draft.notes;
  let truncated = false;
  let url = toUrl(title, buildIssueBody({ ...draft, notes, reply }));
  while (url.length > ISSUE_URL_MAX && reply.length > 0) {
    reply = reply.length < 200 ? "" : reply.slice(0, Math.floor(reply.length * 0.7));
    truncated = true;
    url = toUrl(title, buildIssueBody({ ...draft, notes, reply }, reply.length > 0));
  }
  while (url.length > ISSUE_URL_MAX && notes.length > 200) {
    notes = notes.slice(0, Math.floor(notes.length * 0.7));
    truncated = true;
    url = toUrl(title, buildIssueBody({ ...draft, notes, reply }));
  }
  return { url, truncated };
}
