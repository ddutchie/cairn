/**
 * `@Name` mentions in a chat message (docs/plans/people-layer.md, "Agent and
 * MCP surface"). The composer's picker inserts `@Name`; when the message is
 * sent, each mentioned person is resolved and a short block about them goes to
 * the model with that turn (model-only context, never the system prompt, so the
 * prompt cache is untouched). Pure over `SyncDb`: desktop and mobile share it.
 *
 * Matching is exact on name or alias, case- and accent-insensitive, longest
 * name first. A name two people share is reported as ambiguous, never guessed.
 * The detail comes from the agent's own `people` tool and passes through the
 * same private-persona scrub, so a mention never reveals more than a tool call.
 */

import type { SyncDb } from "../sync/db-adapter";
import type { Person } from "../types/people";
import { scrubHidden } from "../agent/people-privacy";
import { foldName } from "./parse";
import { listPeople } from "./queries";
import { peopleTool, type PeopleToolContext } from "./tool";

/** People named in one message, at most this many get a detail block. */
export const MAX_MENTIONED_PEOPLE = 5;

/** Letters, digits and combining accents continue a word: "@Jose" is not "@José" or "@Joseph". */
const isWordChar = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{M}\p{N}_]/u.test(ch);

export interface FoundMentions {
  matched: Person[];
  /** The text after the `@` for names more than one person answers to. */
  ambiguous: { text: string; people: Person[] }[];
}

/**
 * The people `@`-mentioned in `text`, each once, in order of appearance.
 * `chosen` maps a folded name to the person id the user picked from the
 * suggestions, which settles a name two people share.
 */
export function findMentions(text: string, people: readonly Person[], chosen?: ReadonlyMap<string, string>): FoundMentions {
  const byKey = new Map<string, Person[]>();
  let longest = 0; // the scan never cuts a tracked name short (x3: decomposed accents add characters)
  for (const p of people) {
    for (const raw of [p.name, ...p.aliases]) longest = Math.max(longest, raw.length);
    for (const key of new Set([p.name, ...p.aliases].map(foldName).filter(Boolean))) {
      const list = byKey.get(key) ?? [];
      list.push(p);
      byKey.set(key, list);
    }
  }
  const matched: Person[] = [];
  const ambiguous: FoundMentions["ambiguous"] = [];
  for (let i = text.indexOf("@"); i !== -1; i = text.indexOf("@", i + 1)) {
    if (i > 0 && !/[\s([{,;:"']/.test(text[i - 1])) continue; // an email address, not a mention
    const rest = text.slice(i + 1, i + 1 + longest * 3);
    for (let len = rest.length; len > 0; len--) {
      // A name ends at a word edge: "@Ana" must not match inside "@Anabel".
      if (isWordChar(rest[len - 1]) && isWordChar(text[i + 1 + len])) continue;
      const hit = byKey.get(foldName(rest.slice(0, len)));
      if (!hit) continue;
      const picked = hit.length > 1 ? hit.find((h) => h.id === chosen?.get(foldName(rest.slice(0, len)))) : undefined;
      const one = picked ?? (hit.length === 1 ? hit[0] : undefined);
      if (!one) ambiguous.push({ text: rest.slice(0, len), people: hit });
      else if (!matched.some((m) => m.id === one.id)) matched.push(one);
      break;
    }
  }
  return { matched, ambiguous };
}

/**
 * The model-only block for the people a message mentions, or undefined when it
 * mentions nobody (or People is off). `hidden` is the set of agent-private
 * persona note ids to keep out.
 */
export function personMentionContext(
  db: SyncDb,
  ctx: PeopleToolContext,
  workspaceId: string,
  text: string,
  hidden: ReadonlySet<string>,
  chosen?: ReadonlyMap<string, string>,
): string | undefined {
  if (!ctx.enabled || !workspaceId || !text.includes("@")) return undefined;
  const { matched, ambiguous } = findMentions(text, listPeople(db, workspaceId), chosen);
  if (matched.length === 0 && ambiguous.length === 0) return undefined;

  const lines = ["The user @-mentioned people in this message. What Cairn knows about them (use the `people` tool for more):"];
  for (const p of matched.slice(0, MAX_MENTIONED_PEOPLE)) {
    const base = { workspaceId, personId: p.id };
    const detail = scrubHidden(hidden, {
      person: peopleTool(db, ctx, { ...base, action: "get" }),
      recent: peopleTool(db, ctx, { ...base, action: "timeline", limit: 5 }),
    });
    lines.push(JSON.stringify(detail));
  }
  if (matched.length > MAX_MENTIONED_PEOPLE) lines.push(`(${matched.length - MAX_MENTIONED_PEOPLE} more people mentioned; look them up by name.)`);
  for (const a of ambiguous) {
    lines.push(`"@${a.text}" matches more than one person (${a.people.map((p) => `${p.name} [${p.id}]`).join(", ")}). Ask the user which one before acting on it.`);
  }
  return lines.join("\n");
}

/** The `@query` being typed at the end of the draft, or null. */
export function trailingMention(input: string): { query: string; start: number } | null {
  const m = /(^|[\s(])@([^\n@]{0,40})$/.exec(input);
  return m ? { query: m[2], start: m.index + m[1].length } : null;
}

/** People whose name or alias starts with, or contains, what was typed after `@`. Best matches first. */
export function matchPeople<T extends Pick<Person, "name" | "aliases">>(people: readonly T[], query: string, limit = 8): T[] {
  const q = foldName(query);
  const rank = (p: T): number => {
    const keys = [p.name, ...p.aliases].map(foldName);
    if (!q) return 1;
    if (keys.some((k) => k.startsWith(q))) return 0;
    return keys.some((k) => k.includes(q)) ? 1 : 2;
  };
  return people.filter((p) => rank(p) < 2).sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}


/**
 * The picks that still stand in `text`: one whose `@Name` was deleted or edited
 * is dropped, and so is one whose name now appears more than once, because the
 * draft keeps no record of which occurrence was picked. Either way a name typed
 * by hand asks which person instead of silently meaning the earlier pick.
 */
export function chosenInText(text: string, chosen: ReadonlyMap<string, string>): Map<string, string> {
  const folded = foldName(text);
  const kept = new Map<string, string>();
  for (const [key, id] of chosen) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = folded.match(new RegExp(`(^|[\\s([{,;:"'])@${escaped}(?![\\p{L}\\p{N}_])`, "gu"));
    if (found?.length === 1) kept.set(key, id);
  }
  return kept;
}
