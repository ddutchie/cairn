/**
 * Cairn — team queries (sync protocol 7). A `teams` row is what you know about
 * a team; membership is `people.team`, matched to the team's name ignoring
 * case. So renaming a team renames it on its members, and deleting one takes
 * it off them. Runs on desktop and mobile like `./queries`.
 *
 * Governance: NEVER construct a Database here — these run on the
 * already-constructed handle passed in by the caller.
 */

import type { SyncDb } from "../sync/db-adapter";
import { newId, ts } from "./clock";
import type { Team, TeamCreateInput, TeamLink, TeamPatch } from "../types/people";

type Db = SyncDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const opt = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

/** Collapse spaces the way `groupByTeam` does, so "Sync  team" and "sync team" are one team. */
export const normTeamName = (t: string | null | undefined): string => (t ?? "").trim().replace(/\s+/g, " ");

function parseLinks(value: unknown): TeamLink[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const raw = JSON.parse(value) as unknown;
    return cleanLinks(Array.isArray(raw) ? raw : []);
  } catch {
    return [];
  }
}

/** Keep links with a URL; a missing label becomes the URL's host. */
export function cleanLinks(list: readonly unknown[] | undefined): TeamLink[] {
  const out: TeamLink[] = [];
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const r = (raw ?? {}) as Partial<TeamLink>;
    const url = typeof r.url === "string" ? r.url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let label = typeof r.label === "string" ? r.label.trim() : "";
    if (!label) {
      try { label = new URL(url).host || url; } catch { label = url; }
    }
    out.push({ label, url });
  }
  return out;
}

function toTeam(r: Row): Team {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    description: opt(r.description),
    leadPersonId: opt(r.lead_person_id),
    parentTeamId: opt(r.parent_team_id),
    channel: opt(r.channel),
    links: parseLinks(r.links),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getTeam(db: Db, id: string): Team | null {
  const row = db.prepare("SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL").get(id) as Row | undefined;
  return row ? toTeam(row) : null;
}

/** Teams in the workspace, by name. Two devices can create the same name before they sync; the older row wins. */
export function listTeams(db: Db, workspaceId: string): Team[] {
  const rows = db.prepare("SELECT * FROM teams WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at, id").all(workspaceId) as Row[];
  const seen = new Set<string>();
  const out: Team[] = [];
  for (const r of rows) {
    const key = normTeamName(r.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toTeam(r));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function findTeamByName(db: Db, workspaceId: string, name: string): Team | null {
  const key = normTeamName(name).toLowerCase();
  if (!key) return null;
  return listTeams(db, workspaceId).find((t) => normTeamName(t.name).toLowerCase() === key) ?? null;
}

/** Throws when `parentId` is `teamId` or sits under it. */
function assertNoCycle(db: Db, teamId: string | null, parentId: string | null | undefined): void {
  if (!parentId) return;
  const seen = new Set<string>();
  let cur: string | undefined = parentId;
  while (cur) {
    if (cur === teamId) throw new Error("A team can't sit under itself or a team below it");
    if (seen.has(cur)) break;
    seen.add(cur);
    const parent = getTeam(db, cur);
    if (!parent) {
      if (cur === parentId) throw new Error(`Team not found: ${parentId}`);
      break;
    }
    cur = parent.parentTeamId;
  }
}

export function createTeam(db: Db, input: TeamCreateInput): Team {
  const name = normTeamName(input.name);
  if (!name) throw new Error("A team needs a name");
  if (findTeamByName(db, input.workspaceId, name)) throw new Error(`There is already a team called "${name}"`);
  const id = input.id ?? newId();
  assertNoCycle(db, id, input.parentTeamId);
  const now = ts();
  db.prepare(`
    INSERT INTO teams (id, workspace_id, name, description, lead_person_id, parent_team_id, channel, links, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.workspaceId, name,
    input.description?.trim() || null,
    input.leadPersonId || null,
    input.parentTeamId || null,
    input.channel?.trim() || null,
    JSON.stringify(cleanLinks(input.links)),
    now, now,
  );
  return getTeam(db, id)!;
}

/** Move people from one team name to another (or off any team when `to` is null). */
function moveMembers(db: Db, workspaceId: string, from: string, to: string | null, now: string): void {
  const people = db.prepare("SELECT id, team FROM people WHERE workspace_id = ? AND deleted_at IS NULL AND team IS NOT NULL").all(workspaceId) as Row[];
  const key = normTeamName(from).toLowerCase();
  const update = db.prepare("UPDATE people SET team = ?, updated_at = ? WHERE id = ?");
  for (const p of people) {
    if (normTeamName(p.team).toLowerCase() === key) update.run(to, now, p.id);
  }
}

export function updateTeam(db: Db, id: string, patch: TeamPatch): Team {
  const current = getTeam(db, id);
  if (!current) throw new Error(`Team not found: ${id}`);
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, value: unknown) => { sets.push(`${col} = ?`); params.push(value); };

  let rename: string | null = null;
  if (patch.name !== undefined) {
    const name = normTeamName(patch.name);
    if (!name) throw new Error("A team needs a name");
    const clash = findTeamByName(db, current.workspaceId, name);
    if (clash && clash.id !== id) throw new Error(`There is already a team called "${name}"`);
    if (name !== current.name) { set("name", name); rename = name; }
  }
  if (patch.description !== undefined) set("description", patch.description?.trim() || null);
  if (patch.leadPersonId !== undefined) set("lead_person_id", patch.leadPersonId || null);
  if (patch.parentTeamId !== undefined) {
    assertNoCycle(db, id, patch.parentTeamId);
    set("parent_team_id", patch.parentTeamId || null);
  }
  if (patch.channel !== undefined) set("channel", patch.channel?.trim() || null);
  if (patch.links !== undefined) set("links", JSON.stringify(cleanLinks(patch.links)));
  if (sets.length === 0) return current;

  const now = ts();
  set("updated_at", now);
  db.transaction(() => {
    db.prepare(`UPDATE teams SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    if (rename) moveMembers(db, current.workspaceId, current.name, rename, now);
  })();
  return getTeam(db, id)!;
}

/**
 * Tombstone a team. Its members leave it unless `keepMembers` (then the name
 * stays on them as a team without details), and teams under it move up to its parent.
 */
export function deleteTeam(db: Db, id: string, opts: { keepMembers?: boolean } = {}): void {
  const team = getTeam(db, id);
  if (!team) return;
  const now = ts();
  db.transaction(() => {
    db.prepare("UPDATE teams SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    db.prepare("UPDATE teams SET parent_team_id = ?, updated_at = ? WHERE parent_team_id = ? AND deleted_at IS NULL")
      .run(team.parentTeamId ?? null, now, id);
    if (!opts.keepMembers) moveMembers(db, team.workspaceId, team.name, null, now);
  })();
}
