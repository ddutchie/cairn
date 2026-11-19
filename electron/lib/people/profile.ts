/**
 * Slack profile by reference (W6). A person's title, time zone, pronouns and
 * status are volatile, so they are never written to the person or the persona
 * note: they are read from the user's Slack connector when the person page
 * opens and kept in `person_profile_cache` (device-local, not synced).
 *
 * The page shows the cache first and refreshes in the background when it is
 * older than 24 hours. A failed refresh keeps the last good fields and marks
 * them stale. With no Slack connector (or no Slack id on the person) there is
 * nothing to fetch and the fields are simply absent.
 * Plan: docs/plans/people-layer.md ("1:1 loop").
 */

import type Database from "better-sqlite3";
import { PROFILE_TTL_MS, parseSlackProfile, profileIsFresh, type PersonProfile, type ProfileFields } from "../../../shared/people/oneonone";
import { READ_VERB, isWriteOperation, operationWords, toolServer } from "../../../shared/today/route";
import { getPerson } from "../../db/people-queries";
import { executeExternalTool, getExternalToolDefs, listScopedConnectors } from "../external-tools";
import { getProjects } from "../../db/workspace-queries";

type Db = Database.Database;

const SOURCE = "slack";
/** A failed refresh isn't retried for this long, so reopening a page doesn't hammer a broken connector. */
const RETRY_AFTER_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 15_000;

interface CacheRow { source: string; payload: string; fetched_at: string; error: string | null }

function readCache(db: Db, personId: string): CacheRow | undefined {
  return db.prepare("SELECT source, payload, fetched_at, error FROM person_profile_cache WHERE person_id = ?").get(personId) as CacheRow | undefined;
}

function fieldsOf(payload: string): ProfileFields {
  try {
    const o = JSON.parse(payload);
    return o && typeof o === "object" ? o as ProfileFields : {};
  } catch { return {}; }
}

/** What the page shows right now, from the cache alone. Never calls out. */
export function getCachedProfile(db: Db, personId: string, now = Date.now()): PersonProfile {
  const row = readCache(db, personId);
  if (!row) return { fields: {}, stale: false };
  const fields = fieldsOf(row.payload);
  const has = Object.keys(fields).length > 0;
  return {
    fields,
    ...(has ? { fetchedAt: row.fetched_at } : {}),
    stale: has && (!profileIsFresh(row.fetched_at, now) || !!row.error),
    ...(row.error ? { error: row.error } : {}),
  };
}

/** Forget a person's cached fields (the person was deleted, or their Slack id changed). */
export function clearProfile(db: Db, personId: string): void {
  db.prepare("DELETE FROM person_profile_cache WHERE person_id = ?").run(personId);
}

function writeGood(db: Db, personId: string, fields: ProfileFields, at: string): void {
  db.prepare(`
    INSERT INTO person_profile_cache (person_id, source, payload, fetched_at, error) VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(person_id) DO UPDATE SET source = excluded.source, payload = excluded.payload, fetched_at = excluded.fetched_at, error = NULL
  `).run(personId, SOURCE, JSON.stringify(fields), at);
}

function writeFailure(db: Db, personId: string, error: string, at: string): void {
  // The last good fields and their time stay; only the error is added.
  db.prepare(`
    INSERT INTO person_profile_cache (person_id, source, payload, fetched_at, error) VALUES (?, ?, '{}', ?, ?)
    ON CONFLICT(person_id) DO UPDATE SET error = excluded.error
  `).run(personId, SOURCE, at, error.slice(0, 300));
}

/** The names a Slack user lookup tool goes by, best first. */
const LOOKUP_NAME = [
  /(^|_)(get|read|fetch|lookup|find)_(user|users)_(profile|info)(_|$)/,
  /(^|_)(user|users)_(profile|info)(_|$)/,
  /(^|_)(get|read|fetch|lookup|find)_(user|profile)(_|$)/,
  /(^|_)(profile|user)(_|$)/,
];

/** The id argument a lookup tool takes. Null when its schema has none we recognise. */
const ID_ARG = ["user_id", "userId", "user", "slack_id", "slackId", "id", "member", "member_id"];

export interface LookupTool { name: string; idArg: string }

/** Pick the connector tool that reads one user's profile, from the tool defs of the Slack server. */
export function pickLookupTool(defs: ReadonlyArray<{ function: { name: string; parameters?: unknown } }>, serverId: string): LookupTool | null {
  let best: { tool: LookupTool; rank: number } | null = null;
  for (const d of defs) {
    const name = d.function.name;
    if (toolServer(name) !== serverId) continue;
    const op = operationWords(name).toLowerCase();
    if (isWriteOperation(op) || !READ_VERB.test(op)) continue;
    const rank = LOOKUP_NAME.findIndex((re) => re.test(op));
    if (rank < 0) continue;
    const props = ((d.function.parameters as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
    const idArg = ID_ARG.find((k) => k in props);
    if (!idArg) continue;
    if (!best || rank < best.rank) best = { tool: { name, idArg }, rank };
  }
  return best?.tool ?? null;
}

export interface ProfileDeps {
  now?: () => number;
  /** The user's Slack connector ids across the workspace, in scope. */
  slackServers?: (db: Db, workspaceId: string) => string[];
  defs?: (db: Db, workspaceId: string, scope: string[]) => Promise<Array<{ function: { name: string; parameters?: unknown } }>>;
  call?: (db: Db, workspaceId: string, scope: string[], name: string, args: Record<string, unknown>) => Promise<string>;
}

const attempts = new Map<string, number>();
const inFlight = new Map<string, Promise<PersonProfile>>();

function workspaceScope(db: Db, workspaceId: string): string[] {
  return getProjects(db, workspaceId).filter((p) => p.status !== "archived").map((p) => p.id);
}

function defaultSlackServers(db: Db, workspaceId: string): string[] {
  return listScopedConnectors(db, workspaceId, workspaceScope(db, workspaceId))
    .filter((c) => c.kind === "mcp" && /slack/i.test(`${c.id} ${c.name}`)).map((c) => c.id);
}

/**
 * Refresh a person's profile when the cache is older than 24 hours. Returns what
 * the page should show: fresh fields, or the last good ones marked stale on a
 * failure. Concurrent calls for one person share one fetch.
 */
export function refreshProfile(db: Db, personId: string, deps: ProfileDeps = {}): Promise<PersonProfile> {
  const running = inFlight.get(personId);
  if (running) return running;
  const p = doRefresh(db, personId, deps).finally(() => inFlight.delete(personId));
  inFlight.set(personId, p);
  return p;
}

async function doRefresh(db: Db, personId: string, deps: ProfileDeps): Promise<PersonProfile> {
  const now = deps.now ?? Date.now;
  const person = getPerson(db, personId);
  const cached = () => getCachedProfile(db, personId, now());
  if (!person || !person.slackId) return cached();
  const row = readCache(db, personId);
  if (row && !row.error && profileIsFresh(row.fetched_at, now())) return cached();
  const last = attempts.get(personId);
  if (last !== undefined && now() - last < RETRY_AFTER_MS) return cached();

  const servers = (deps.slackServers ?? defaultSlackServers)(db, person.workspaceId);
  // No Slack connector: nothing to fetch, nothing to flag.
  if (servers.length === 0) return cached();
  attempts.set(personId, now());
  const scope = workspaceScope(db, person.workspaceId);
  try {
    const defs = await (deps.defs ?? ((d, w, s) => getExternalToolDefs(d, w, s)))(db, person.workspaceId, scope);
    let failure = "Slack has no tool that reads a profile.";
    for (const serverId of servers) {
      const tool = pickLookupTool(defs, serverId);
      if (!tool) continue;
      const call = deps.call ?? ((d, w, s, n, a) => executeExternalTool(d, w, s, n, a, AbortSignal.timeout(CALL_TIMEOUT_MS), { getOnly: true }));
      const reply = await call(db, person.workspaceId, scope, tool.name, { [tool.idArg]: person.slackId });
      if (/^Error:/i.test(reply.trim())) { failure = reply.trim().slice(0, 200); continue; }
      const fields = parseSlackProfile(reply);
      if (!fields) { failure = "Slack's reply had no profile fields."; continue; }
      writeGood(db, personId, fields, new Date(now()).toISOString());
      return cached();
    }
    writeFailure(db, personId, failure, new Date(now()).toISOString());
  } catch (err) {
    writeFailure(db, personId, err instanceof Error ? err.message : String(err), new Date(now()).toISOString());
  }
  return cached();
}

/** Test seam: forget retry bookkeeping. */
export function resetProfileThrottle(): void { attempts.clear(); inFlight.clear(); }

export { PROFILE_TTL_MS };
