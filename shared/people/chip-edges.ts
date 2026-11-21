/**
 * One answer to "who manages whom". A relationship chip that describes
 * structure ("manager", "direct report", "mentor", "buddy", "stakeholder") is
 * the same fact as an edge between that person and you, so the two are kept
 * as one:
 *
 * - Writing such a chip writes the edge (`queries.updatePerson`); taking the
 *   chip off ends the edge, so it reads "former manager".
 * - Writing, ending or removing an edge to you sets or clears the chip
 *   (`queries.addEdge` / `updateEdge` / `removeEdge`).
 * - Reading resolves anything that still disagrees (a sync race, rows from
 *   before this rule): when a confirmed edge exists for the pair it decides,
 *   current or ended; the chip only counts where there is no edge
 *   (`reconcileChips`). Without a "me" person there are no edges to you, so
 *   chips stand alone.
 *
 * "peer", "recruiter", "candidate" and "other" stay chips only.
 */
import type { PersonEdgeType, Provenance, Relationship, RelationshipType } from "../types/people";
import { edgeRowId } from "./ids";

/** How a chip on someone reads as an edge between them and you: they are your <chip>. */
export const CHIP_EDGES: Partial<Record<RelationshipType, { type: PersonEdgeType; meIsSource: boolean }>> = {
  direct_report: { type: "manager_of", meIsSource: true },
  manager: { type: "manager_of", meIsSource: false },
  mentor: { type: "mentor_of", meIsSource: false },
  buddy: { type: "buddy_of", meIsSource: false },
  stakeholder: { type: "stakeholder_of", meIsSource: false },
};

export const isStructuralChip = (t: RelationshipType): boolean => CHIP_EDGES[t] !== undefined;

/** The edge row a chip on `otherId` stands for. */
export function chipEdge(chip: RelationshipType, meId: string, otherId: string): { id: string; type: PersonEdgeType; sourceId: string; targetId: string } | null {
  const map = CHIP_EDGES[chip];
  if (!map) return null;
  const [sourceId, targetId] = map.meIsSource ? [meId, otherId] : [otherId, meId];
  return { id: edgeRowId(map.type, sourceId, targetId), type: map.type, sourceId, targetId };
}

/** The chip an edge stands for on the other person, when one end is you. */
export function edgeChip(edge: { type: PersonEdgeType; sourceId: string; targetId: string }, meId: string): { otherId: string; chip: RelationshipType } | null {
  if (edge.sourceId !== meId && edge.targetId !== meId) return null;
  const meIsSource = edge.sourceId === meId;
  for (const [chip, map] of Object.entries(CHIP_EDGES) as [RelationshipType, { type: PersonEdgeType; meIsSource: boolean }][]) {
    if (map.type === edge.type && map.meIsSource === meIsSource) return { otherId: meIsSource ? edge.targetId : edge.sourceId, chip };
  }
  return null;
}

export interface EdgeFact {
  ended: boolean;
  label?: string;
  provenance: Provenance;
}

/**
 * A person's chips with edges to you applied: a current edge adds its chip,
 * an ended one takes it away, and a chip with no edge stays.
 */
export function reconcileChips(chips: readonly Relationship[], meId: string, otherId: string, edges: ReadonlyMap<string, EdgeFact>): Relationship[] {
  const out: Relationship[] = [];
  const has = new Set<RelationshipType>();
  for (const r of chips) {
    const e = chipEdge(r.type, meId, otherId);
    const fact = e ? edges.get(e.id) : undefined;
    if (fact?.ended) continue;
    out.push(r);
    has.add(r.type);
  }
  for (const chip of Object.keys(CHIP_EDGES) as RelationshipType[]) {
    if (has.has(chip)) continue;
    const fact = edges.get(chipEdge(chip, meId, otherId)!.id);
    if (fact && !fact.ended) out.push({ type: chip, ...(fact.label ? { label: fact.label } : {}), provenance: fact.provenance });
  }
  return out;
}
