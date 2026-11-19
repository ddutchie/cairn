/**
 * Name/email/Slack-id matching for the People layer (decision 12 in
 * docs/plans/people-layer.md): exact, never fuzzy. Slack id, then email, then
 * name, alias or persona note title compared case- and accent-insensitively.
 * Two candidates make an ambiguous result for the user to settle; a person the
 * user dismissed is reported as such so nobody re-creates them. Pure, shared by
 * desktop capture, mobile and the action-item index.
 */

import type { PeopleStatus } from "../types/people";
import { foldName } from "./parse";

export interface PersonLookup {
  slackId?: string;
  email?: string;
  name?: string;
}

export type Resolution =
  | { kind: "match"; personId: string }
  | { kind: "ambiguous"; personIds: string[] }
  | { kind: "dismissed"; personId: string }
  | { kind: "none" };

export interface Candidate {
  id: string;
  status: PeopleStatus;
  slackId: string | null;
  emails: string[];
  keys: Set<string>;
}

/** Resolve one reference against preloaded candidates. */
export function resolveIn(candidates: readonly Candidate[], ref: PersonLookup): Resolution {
  const pick = (hits: Candidate[]): Resolution | null => {
    if (hits.length === 0) return null;
    const live = hits.filter((h) => h.status !== "dismissed");
    if (live.length === 0) return { kind: "dismissed", personId: hits[0].id };
    return live.length === 1 ? { kind: "match", personId: live[0].id } : { kind: "ambiguous", personIds: live.map((h) => h.id) };
  };
  const slack = ref.slackId?.trim();
  if (slack) {
    const r = pick(candidates.filter((c) => c.slackId === slack));
    if (r) return r;
  }
  const email = ref.email?.trim().toLowerCase();
  if (email) {
    const r = pick(candidates.filter((c) => c.emails.includes(email)));
    if (r) return r;
  }
  const name = ref.name ? foldName(ref.name) : "";
  if (name) {
    const r = pick(candidates.filter((c) => c.keys.has(name)));
    if (r) return r;
  }
  return { kind: "none" };
}

