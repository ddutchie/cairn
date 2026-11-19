/**
 * Owned checklist lines ("action items") in a note body: which ones a note
 * has, who owns them, and ticking one by its line key. The desktop indexes
 * them into `note_action_items` (`electron/db/people-indexing.ts`); mobile has
 * no index table and reads them from note bodies on demand. Both use these
 * functions, so a line gets the same key everywhere and a tick made on one
 * device finds the same line on the other. Pure.
 */

import { actionItemLineKey } from "./ids";
import { parseChecklist } from "./parse";
import { resolveIn, type Candidate } from "./resolve";

export interface OwnedItem {
  /** `actionItemLineKey` of the line (`#2` suffix for a duplicate line in the same note). */
  lineKey: string;
  /** The owner as written ("Chris"), or their email. */
  ownerText: string | null;
  /** The one person the owner text names, or null (a team, an unknown name, an ambiguous one). */
  ownerPersonId: string | null;
  text: string;
  done: boolean;
}

/** Keys for every owned and unowned checklist line, in order; duplicates of one line get `#2`, `#3`. */
function keyedLines(content: string) {
  const seen = new Map<string, number>();
  return parseChecklist(content).map((item) => {
    const base = actionItemLineKey(item.raw);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { item, key: n === 1 ? base : `${base}#${n}` };
  });
}

/** Owned checklist lines in a body, with the person each names (only on a single match, never a stub). */
export function ownedItemsIn(content: string, candidates: readonly Candidate[]): OwnedItem[] {
  const out: OwnedItem[] = [];
  for (const { item, key } of keyedLines(content)) {
    if (!item.owner) continue;
    const r = resolveIn(candidates, item.owner);
    out.push({
      lineKey: key,
      ownerText: item.owner.name ?? item.owner.email ?? null,
      ownerPersonId: r.kind === "match" ? r.personId : null,
      text: item.text,
      done: item.done,
    });
  }
  return out;
}

/**
 * Tick (or untick) the checklist line with this key. Only the box changes; the
 * rest of the line and body stay byte for byte. Returns the new body, the same
 * body when the line is already in that state, or null when no line has the key
 * (the note changed since the item was listed).
 */
export function setItemDone(content: string, lineKey: string, done: boolean): string | null {
  const hit = keyedLines(content).find((l) => l.key === lineKey);
  if (!hit) return null;
  if (hit.item.done === done) return content;
  // Split keeping the original line endings so a CRLF note stays CRLF.
  const parts = content.split(/(\r?\n)/);
  const idx = hit.item.line * 2;
  parts[idx] = parts[idx].replace(/^(\s*[-*+]\s+)\[[ xX]\]/, `$1[${done ? "x" : " "}]`);
  return parts.join("");
}
