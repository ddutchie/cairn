/**
 * One-time adoption of what the first People builds stored loosely, run by the
 * desktop's v69 and mobile's v14 migrations:
 *
 * - `people.team` (free text, one per person) becomes a membership of a team
 *   row with that name, made when there is none. Only for people with no
 *   membership rows at all, so it never undoes a later change.
 * - Structural relationship chips ("manager", "direct report", …) become
 *   edges to you (`adoptChipEdges`).
 *
 * Every id written comes from the data (`teamRowId`, `membershipRowId`,
 * `edgeRowId`), so two devices adopting the same people write the same rows
 * and sync converges on one. No transactions: the migration holds one.
 */
import type { SyncDb } from "../sync/db-adapter";
import { adoptChipEdges } from "./queries";
import { addMember, ensureTeam, normTeamName } from "./team-queries";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function adoptPeopleStructure(db: SyncDb): { memberships: number; edges: number } {
  let memberships = 0;
  const rows = db.prepare(`
    SELECT p.id, p.workspace_id, p.team FROM people p
    WHERE p.deleted_at IS NULL AND p.team IS NOT NULL AND TRIM(p.team) != ''
      AND NOT EXISTS (SELECT 1 FROM team_memberships m WHERE m.person_id = p.id)
    ORDER BY p.created_at, p.id
  `).all() as Row[];
  for (const r of rows) {
    const name = normTeamName(r.team);
    if (!name) continue;
    const team = ensureTeam(db, r.workspace_id, name);
    // When they joined is unknown.
    addMember(db, { teamId: team.id, personId: r.id, startedAt: null });
    memberships++;
  }
  let edges = 0;
  const workspaces = db.prepare("SELECT DISTINCT workspace_id FROM people WHERE deleted_at IS NULL").all() as Row[];
  for (const w of workspaces) edges += adoptChipEdges(db, w.workspace_id);
  return { memberships, edges };
}
