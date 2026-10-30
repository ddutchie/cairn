/** search_sessions / read_session: look up earlier chats and coding sessions in the same workspace. */
import { stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { listSessions, readSession, SESSION_FILE } from "../session/log";
import { deriveTitle } from "../session/history";
import type { SessionRecord } from "../session/format";
import { clampMiddle, fail, ok } from "./schema";

export interface SessionToolDeps {
  /** Directory holding one folder per session log. */
  root: string;
  /** The running session: never searched, the model already has it. */
  currentSession: string;
  /** Sessions of this workspace; anything else stays invisible. */
  workspaceSessionIds: () => Set<string>;
}

const MAX_SCANNED = 400;
const SNIPPET = 160;
const READ_CHARS = 12_000;

interface Turn { index: number; role: "user" | "assistant"; text: string; time: number }

/** The human-readable turns of a session: what was asked and what the assistant said. */
export function turnsOf(records: readonly SessionRecord[]): Turn[] {
  const out: Turn[] = [];
  for (const { event, time } of records) {
    if (event.type === "user/message") out.push({ index: out.length, role: "user", text: event.content, time });
    else if (event.type === "assistant/message") {
      const text = event.message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("").trim();
      if (text) out.push({ index: out.length, role: "assistant", text, time });
    }
  }
  return out;
}

function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
  const start = Math.max(0, (Number.isFinite(at) ? at : 0) - 50);
  const slice = text.slice(start, start + SNIPPET).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${start + SNIPPET < text.length ? "…" : ""}`;
}

const kindOf = (id: string) => (id.startsWith("chat-") ? "chat" : "coding");
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export function sessionTools(deps: SessionToolDeps): AgentTool[] {
  return [
    defineTool({
      name: "search_sessions",
      description: "Search your earlier chats and coding sessions in this workspace for a phrase (all words must appear). Returns matching sessions with the matching messages; read one in full with read_session. Use it to recall what was decided or done before.",
      parameters: Type.Object({
        query: Type.String({ description: "Words to look for, e.g. \"export format decision\"." }),
        limit: Type.Optional(Type.Number({ description: "Maximum sessions to return (default 8)." })),
        sinceDays: Type.Optional(Type.Number({ description: "Only sessions updated in the last N days." })),
      }),
      risk: () => ({ class: "READ" }),
      concurrency: "parallel",
      async execute(a) {
        const terms = a.query.toLowerCase().split(/\s+/).filter(Boolean);
        if (!terms.length) return fail("Give at least one search word.");
        const allowed = deps.workspaceSessionIds();
        const cutoff = a.sinceDays ? Date.now() - a.sinceDays * 86_400_000 : 0;
        const candidates: Array<{ id: string; mtime: number }> = [];
        for (const id of await listSessions(deps.root)) {
          if (id === deps.currentSession || !allowed.has(id)) continue;
          try {
            const mtime = (await stat(path.join(deps.root, id, SESSION_FILE))).mtimeMs;
            if (mtime >= cutoff) candidates.push({ id, mtime });
          } catch { /* no log */ }
        }
        candidates.sort((x, y) => y.mtime - x.mtime);
        const limit = Math.min(20, Math.max(1, Math.floor(a.limit ?? 8)));
        const found: string[] = [];
        for (const { id, mtime } of candidates.slice(0, MAX_SCANNED)) {
          if (found.length >= limit) break;
          const log = await readSession(deps.root, id).catch(() => undefined);
          if (!log || log.header.parentId) continue; // subagent children are part of their parent's story
          const turns = turnsOf(log.records);
          const hits = turns.filter((t) => { const l = t.text.toLowerCase(); return terms.every((w) => l.includes(w)); });
          if (!hits.length) continue;
          const title = deriveTitle(log.records) ?? id;
          found.push([`${id} — ${kindOf(id)}, ${day(mtime)} — ${title}`, ...hits.slice(0, 3).map((h) => `  #${h.index} ${h.role}: ${snippet(h.text, terms)}`), hits.length > 3 ? `  (+${hits.length - 3} more matching messages)` : ""].filter(Boolean).join("\n"));
        }
        if (!found.length) return ok(`No earlier session in this workspace mentions all of: ${terms.join(", ")}.`);
        return ok(`${found.length} session${found.length === 1 ? "" : "s"}, newest first:\n\n${found.join("\n\n")}\n\nRead one with read_session {id, from: <message #>}.`);
      },
    }),
    defineTool({
      name: "read_session",
      description: "Read the messages of an earlier session found with search_sessions.",
      parameters: Type.Object({
        id: Type.String({ description: "Session id from search_sessions." }),
        from: Type.Optional(Type.Number({ description: "First message number to read (default 0)." })),
        limit: Type.Optional(Type.Number({ description: "How many messages (default 20)." })),
      }),
      risk: () => ({ class: "READ" }),
      concurrency: "parallel",
      async execute(a) {
        if (a.id === deps.currentSession) return fail("That is the current session; you already have it.");
        if (!deps.workspaceSessionIds().has(a.id)) return fail(`No session ${a.id} in this workspace.`);
        let log;
        try { log = await readSession(deps.root, a.id); } catch { return fail(`Invalid session id: ${a.id}`); }
        if (!log) return fail(`No session ${a.id} in this workspace.`);
        const turns = turnsOf(log.records);
        const from = Math.max(0, Math.floor(a.from ?? 0));
        const slice = turns.slice(from, from + Math.min(50, Math.max(1, Math.floor(a.limit ?? 20))));
        if (!slice.length) return ok(`Session ${a.id} has ${turns.length} messages; none from #${from}.`);
        const body = slice.map((t) => `#${t.index} ${t.role} (${day(t.time)}):\n${t.text}`).join("\n\n");
        const more = from + slice.length < turns.length ? `\n\n[${turns.length - from - slice.length} more; continue with from: ${from + slice.length}]` : "";
        return ok(`${deriveTitle(log.records) ?? a.id} — ${kindOf(a.id)}, ${turns.length} messages\n\n${clampMiddle(body, READ_CHARS)}${more}`);
      },
    }),
  ];
}
