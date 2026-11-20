/**
 * Cairn — team and membership queries (sync protocol 7). A `teams` row is a
 * group and what you know about it; `team_memberships` says who is on it, in
 * what role, and from when to when. A team's id is fixed when it is made
 * (`teamRowId`), so a rename touches one row and membership never moves.
 * Runs on desktop and mobile like `./queries`.
 *
 * Nothing here opens a transaction that the migrations call into
 * (`createTeam`, `addMember`, `endMember`): the mobile adapter can't nest a
 * transaction inside the migration's own.
 *
 * Governance: NEVER construct a Database here — these run on the
 * already-constructed handle passed in by the caller.
 */

import type { SyncDb } from "../sync/db-adapter";
import { ts } from "./clock";
import { membershipRowId, teamRowId } from "./ids";
import {
  TEAM_KINDS,
  type AddMemberInput, type PersonTeam, type Team, type TeamCreateInput, type TeamKind, type TeamLink, type TeamMembership, type TeamPatch,
} from "../types/people";

type Db = SyncDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const opt = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

/** Collapse spaces, so "Sync  team" and "Sync team" are one name. */
export const normTeamName = (t: string | null | undefined): string => (t ?? "").trim().replace(/\s+/g, " ");
/** The key two names are compared by: spaces collapsed, case ignored. */
export const foldTeamName = (t: string | null | undefined): string => normTeamName(t).toLowerCase();

export function teamKind(value: unknown): TeamKind {
  return (TEAM_KINDS as readonly unknown[]).includes(value) ? (value as TeamKind) : "team";
}

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
    kind: teamKind(r.kind),
    description: opt(r.description),
    leadPersonId: opt(r.lead_person_id),
    parentTeamId: opt(r.parent_team_id),
    channel: opt(r.channel),
    links: parseLinks(r.links),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toMembership(r: Row): TeamMembership {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    personId: r.person_id,
    role: opt(r.role),
    startedAt: opt(r.started_at),
    endedAt: opt(r.ended_at),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getTeam(db: Db, id: string): Team | null {
  const row = db.prepare("SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL").get(id) as Row | undefined;
  return row ? toTeam(row) : null;
}

/**
 * Every live team in the workspace, by name. Two rows can share a name (two
 * devices renamed different teams to it before they synced); both are
 * listed, and `mergeTeams` makes them one.
 */
export function listTeams(db: Db, workspaceId: string): Team[] {
  const rows = db.prepare("SELECT * FROM teams WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at, id").all(workspaceId) as Row[];
  return rows.map(toTeam).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** The team with this name (the oldest, when two share it). */
export function findTeamByName(db: Db, workspaceId: string, name: string): Team | null {
  const key = foldTeamName(name);
  if (!key) return null;
  const rows = db.prepare("SELECT * FROM teams WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at, id").all(workspaceId) as Row[];
  const row = rows.find((r) => foldTeamName(r.name) === key);
  return row ? toTeam(row) : null;
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

/**
 * Make a team. Its id comes from the workspace and the folded name, so the
 * same team made on two devices is one row; a removed team with that id comes
 * back, and an id still held by a team that was renamed moves on to `~2`.
 */
export function createTeam(db: Db, input: TeamCreateInput): Team {
  const name = normTeamName(input.name);
  if (!name) throw new Error("A team needs a name");
  if (findTeamByName(db, input.workspaceId, name)) throw new Error(`There is already a team called "${name}"`);
  const now = ts();
  const values = [
    input.workspaceId, name, teamKind(input.kind),
    input.description?.trim() || null,
    input.leadPersonId || null,
    input.parentTeamId || null,
    input.channel?.trim() || null,
    JSON.stringify(cleanLinks(input.links)),
  ];
  let id = input.id;
  if (!id) {
    for (let n = 1; ; n++) {
      const candidate = teamRowId(input.workspaceId, foldTeamName(name), n);
      const row = db.prepare("SELECT deleted_at FROM teams WHERE id = ?").get(candidate) as Row | undefined;
      if (!row) { id = candidate; break; }
      if (row.deleted_at) {
        assertNoCycle(db, candidate, input.parentTeamId);
        // Revive with the new facts (an UPDATE, so sync sends a put that has seen the delete).
        db.prepare(`
          UPDATE teams SET deleted_at = NULL, workspace_id = ?, name = ?, kind = ?, description = ?, lead_person_id = ?,
            parent_team_id = ?, channel = ?, links = ?, updated_at = ?
          WHERE id = ?
        `).run(...values, now, candidate);
        return getTeam(db, candidate)!;
      }
    }
  }
  assertNoCycle(db, id, input.parentTeamId);
  db.prepare(`
    INSERT INTO teams (id, workspace_id, name, kind, description, lead_person_id, parent_team_id, channel, links, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ...values, now, now);
  return getTeam(db, id)!;
}

/** The team with this name, made when there is none. */
export function ensureTeam(db: Db, workspaceId: string, name: string): Team {
  return findTeamByName(db, workspaceId, name) ?? createTeam(db, { workspaceId, name });
}

/** Change a team's details. A rename keeps the id, so its members stay on it. */
export function updateTeam(db: Db, id: string, patch: TeamPatch): Team {
  const current = getTeam(db, id);
  if (!current) throw new Error(`Team not found: ${id}`);
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, value: unknown) => { sets.push(`${col} = ?`); params.push(value); };

  if (patch.name !== undefined) {
    const name = normTeamName(patch.name);
    if (!name) throw new Error("A team needs a name");
    const clash = findTeamByName(db, current.workspaceId, name);
    if (clash && clash.id !== id) throw new Error(`There is already a team called "${name}"`);
    if (name !== current.name) set("name", name);
  }
  if (patch.kind !== undefined) set("kind", teamKind(patch.kind));
  if (patch.description !== undefined) set("description", patch.description?.trim() || null);
  if (patch.leadPersonId !== undefined) set("lead_person_id", patch.leadPersonId || null);
  if (patch.parentTeamId !== undefined) {
    assertNoCycle(db, id, patch.parentTeamId);
    set("parent_team_id", patch.parentTeamId || null);
  }
  if (patch.channel !== undefined) set("channel", patch.channel?.trim() || null);
  if (patch.links !== undefined) set("links", JSON.stringify(cleanLinks(patch.links)));
  if (sets.length === 0) return current;
  set("updated_at", ts());
  db.prepare(`UPDATE teams SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  return getTeam(db, id)!;
}

/** Tombstone a team and its memberships; teams under it move up to its parent. */
export function deleteTeam(db: Db, id: string): void {
  const team = getTeam(db, id);
  if (!team) return;
  const now = ts();
  db.transaction(() => {
    db.prepare("UPDATE teams SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    db.prepare("UPDATE teams SET parent_team_id = ?, updated_at = ? WHERE parent_team_id = ? AND deleted_at IS NULL")
      .run(team.parentTeamId ?? null, now, id);
    db.prepare("UPDATE team_memberships SET deleted_at = ?, updated_at = ? WHERE team_id = ? AND deleted_at IS NULL").run(now, now, id);
  })();
}

/**
 * Fold `dropId` into `keepId`: its members (with their dates and roles) move
 * over, the teams under it move too, `keepId` takes any detail it lacks, and
 * `dropId` is removed. For two teams that are one (two devices named
 * different teams the same before they synced, or a team that was made twice).
 */
export function mergeTeams(db: Db, keepId: string, dropId: string): Team {
  if (keepId === dropId) throw new Error("Pick two different teams to merge");
  const keep = getTeam(db, keepId);
  const drop = getTeam(db, dropId);
  if (!keep) throw new Error(`Team not found: ${keepId}`);
  if (!drop) throw new Error(`Team not found: ${dropId}`);
  if (keep.workspaceId !== drop.workspaceId) throw new Error("Those teams are in different workspaces");
  const now = ts();
  db.transaction(() => {
    for (const m of listTeamMemberships(db, dropId)) {
      const there = getMembership(db, keepId, m.personId);
      if (!there) {
        writeMembership(db, { workspaceId: keep.workspaceId, teamId: keepId, personId: m.personId, role: m.role, startedAt: m.startedAt, endedAt: m.endedAt }, now);
      } else {
        // One stint that covers both: the earlier start, still current if either is, and any role.
        const startedAt = [there.startedAt, m.startedAt].filter(Boolean).sort()[0];
        const endedAt = !there.endedAt || !m.endedAt ? undefined : [there.endedAt, m.endedAt].sort().reverse()[0];
        writeMembership(db, { workspaceId: keep.workspaceId, teamId: keepId, personId: m.personId, role: there.role ?? m.role, startedAt, endedAt }, now);
      }
    }
    db.prepare("UPDATE team_memberships SET deleted_at = ?, updated_at = ? WHERE team_id = ? AND deleted_at IS NULL").run(now, now, dropId);
    db.prepare("UPDATE teams SET parent_team_id = ?, updated_at = ? WHERE parent_team_id = ? AND deleted_at IS NULL AND id != ?")
      .run(keepId, now, dropId, keepId);
    const fill: TeamPatch = {};
    if (!keep.description && drop.description) fill.description = drop.description;
    if (!keep.leadPersonId && drop.leadPersonId) fill.leadPersonId = drop.leadPersonId;
    if (!keep.channel && drop.channel) fill.channel = drop.channel;
    if (drop.links.length) fill.links = [...keep.links, ...drop.links];
    if (!keep.parentTeamId && drop.parentTeamId && drop.parentTeamId !== keepId) {
      try { assertNoCycle(db, keepId, drop.parentTeamId); fill.parentTeamId = drop.parentTeamId; } catch { /* would loop: leave it a root */ }
    }
    db.prepare("UPDATE teams SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, dropId);
    if (Object.keys(fill).length) updateTeam(db, keepId, fill);
  })();
  return getTeam(db, keepId)!;
}

// ── Memberships ───────────────────────────────

export function getMembership(db: Db, teamId: string, personId: string): TeamMembership | null {
  const row = db.prepare("SELECT * FROM team_memberships WHERE id = ? AND deleted_at IS NULL").get(membershipRowId(teamId, personId)) as Row | undefined;
  return row ? toMembership(row) : null;
}

/** Every membership in the workspace, past ones included, oldest first. */
export function listMemberships(db: Db, workspaceId: string): TeamMembership[] {
  const rows = db.prepare(`
    SELECT m.* FROM team_memberships m
    JOIN teams t ON t.id = m.team_id AND t.deleted_at IS NULL
    JOIN people p ON p.id = m.person_id AND p.deleted_at IS NULL
    WHERE m.workspace_id = ? AND m.deleted_at IS NULL
    ORDER BY m.created_at, m.id
  `).all(workspaceId) as Row[];
  return rows.map(toMembership);
}

/** A team's memberships, past ones included. */
export function listTeamMemberships(db: Db, teamId: string): TeamMembership[] {
  const rows = db.prepare(`
    SELECT m.* FROM team_memberships m JOIN people p ON p.id = m.person_id AND p.deleted_at IS NULL
    WHERE m.team_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at, m.id
  `).all(teamId) as Row[];
  return rows.map(toMembership);
}

interface MembershipFacts {
  workspaceId: string;
  teamId: string;
  personId: string;
  role?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

/** Insert or overwrite the row for (team, person), reviving a removed one. */
function writeMembership(db: Db, m: MembershipFacts, now: string): void {
  const id = membershipRowId(m.teamId, m.personId);
  const existing = db.prepare("SELECT id FROM team_memberships WHERE id = ?").get(id) as Row | undefined;
  const role = m.role?.trim() || null;
  if (existing) {
    db.prepare(`
      UPDATE team_memberships SET deleted_at = NULL, workspace_id = ?, team_id = ?, person_id = ?, role = ?, started_at = ?, ended_at = ?, updated_at = ?
      WHERE id = ?
    `).run(m.workspaceId, m.teamId, m.personId, role, m.startedAt ?? null, m.endedAt ?? null, now, id);
  } else {
    db.prepare(`
      INSERT INTO team_memberships (id, workspace_id, team_id, person_id, role, started_at, ended_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, m.workspaceId, m.teamId, m.personId, role, m.startedAt ?? null, m.endedAt ?? null, now, now);
  }
}


/**
 * Put someone on a team. Already on it: only the role changes (when given).
 * On it before and left: a new stint starts (the row is reused, so the
 * earlier stint's dates are replaced).
 */
export function addMember(db: Db, input: AddMemberInput): TeamMembership {
  const team = getTeam(db, input.teamId);
  if (!team) throw new Error(`Team not found: ${input.teamId}`);
  const person = db.prepare("SELECT workspace_id FROM people WHERE id = ? AND deleted_at IS NULL").get(input.personId) as Row | undefined;
  if (!person) throw new Error(`Person not found: ${input.personId}`);
  if (person.workspace_id !== team.workspaceId) throw new Error("That person and team are in different workspaces");
  const now = ts();
  const current = getMembership(db, input.teamId, input.personId);
  if (current && !current.endedAt) {
    if (input.role !== undefined || input.startedAt !== undefined) {
      writeMembership(db, {
        ...current,
        role: input.role === undefined ? current.role : input.role,
        startedAt: input.startedAt === undefined ? current.startedAt : input.startedAt,
      }, now);
    }
  } else {
    writeMembership(db, {
      workspaceId: team.workspaceId, teamId: input.teamId, personId: input.personId,
      role: input.role === undefined ? current?.role : input.role,
      startedAt: input.startedAt === undefined ? now : input.startedAt,
      endedAt: null,
    }, now);
  }
  return getMembership(db, input.teamId, input.personId)!;
}

/** Take someone off a team, keeping the stint as history. Not on it: nothing happens. */
export function endMember(db: Db, teamId: string, personId: string, endedAt: string = ts()): void {
  const m = getMembership(db, teamId, personId);
  if (!m || m.endedAt) return;
  writeMembership(db, { ...m, endedAt }, ts());
}

/** Forget a membership entirely (added by mistake): no history is kept. */
export function deleteMembership(db: Db, teamId: string, personId: string): void {
  const now = ts();
  db.prepare("UPDATE team_memberships SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, membershipRowId(teamId, personId));
}

/** Home team first: teams of kind "team" before the rest, then the longest-standing, then by name. */
function homeFirst(a: PersonTeam, b: PersonTeam): number {
  return Number(a.kind !== "team") - Number(b.kind !== "team")
    || (a.startedAt ?? "").localeCompare(b.startedAt ?? "")
    || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** Each person's current teams in a workspace (or for the given people), home team first. */
export function currentTeamsByPerson(db: Db, workspaceId: string, personId?: string): Map<string, PersonTeam[]> {
  const rows = db.prepare(`
    SELECT m.person_id, m.team_id, m.role, m.started_at, t.name, t.kind FROM team_memberships m
    JOIN teams t ON t.id = m.team_id AND t.deleted_at IS NULL
    WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND m.ended_at IS NULL ${personId ? "AND m.person_id = ?" : ""}
  `).all(...(personId ? [workspaceId, personId] : [workspaceId])) as Row[];
  const out = new Map<string, PersonTeam[]>();
  for (const r of rows) {
    const list = out.get(r.person_id) ?? [];
    list.push({ teamId: r.team_id, name: r.name, kind: teamKind(r.kind), ...(r.role ? { role: r.role } : {}), ...(r.started_at ? { startedAt: r.started_at } : {}) });
    out.set(r.person_id, list);
  }
  for (const list of out.values()) list.sort(homeFirst);
  return out;
}

/**
 * Move someone to a team by name (made when new), ending their other
 * memberships of kind "team"; guilds, projects and committees stay. `null`
 * takes them off every team of kind "team".
 */
export function setHomeTeam(db: Db, personId: string, name: string | null): void {
  const person = db.prepare("SELECT workspace_id FROM people WHERE id = ? AND deleted_at IS NULL").get(personId) as Row | undefined;
  if (!person) throw new Error(`Person not found: ${personId}`);
  const workspaceId = person.workspace_id as string;
  const target = name && normTeamName(name) ? ensureTeam(db, workspaceId, name) : null;
  for (const t of currentTeamsByPerson(db, workspaceId, personId).get(personId) ?? []) {
    if (t.kind === "team" && t.teamId !== target?.id) endMember(db, t.teamId, personId);
  }
  if (target) addMember(db, { teamId: target.id, personId });
}

/**
 * Move every membership of one person to another (merging two people): a
 * team both are on keeps one stint with the earlier start, current if either is.
 */
export function moveMemberships(db: Db, fromPersonId: string, toPersonId: string): void {
  const now = ts();
  const rows = db.prepare("SELECT * FROM team_memberships WHERE person_id = ? AND deleted_at IS NULL").all(fromPersonId) as Row[];
  for (const r of rows.map(toMembership)) {
    const there = getMembership(db, r.teamId, toPersonId);
    const startedAt = there ? [there.startedAt, r.startedAt].filter(Boolean).sort()[0] : r.startedAt;
    const endedAt = there ? (!there.endedAt || !r.endedAt ? undefined : [there.endedAt, r.endedAt].sort().reverse()[0]) : r.endedAt;
    writeMembership(db, { workspaceId: r.workspaceId, teamId: r.teamId, personId: toPersonId, role: there?.role ?? r.role, startedAt, endedAt }, now);
  }
  db.prepare("UPDATE team_memberships SET deleted_at = ?, updated_at = ? WHERE person_id = ? AND deleted_at IS NULL").run(now, now, fromPersonId);
}
