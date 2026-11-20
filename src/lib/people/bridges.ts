/**
 * Single points of dependence (People view, "Bridges"): people you reach
 * others through. For each person, who would be cut off from you if they
 * were out of the picture. Uses the same links as the relationship canvas.
 */
import type { PersonSummary } from "../../../shared/types/people-view";
import { findMe, type NetworkLink } from "./network";

export interface Dependence {
  person: PersonSummary;
  /** People only reachable from you through this person, by name. */
  cutOff: PersonSummary[];
}

export interface BridgeModel {
  me: PersonSummary | null;
  /** Largest dependence first. */
  dependencies: Dependence[];
  /** People with no path to you at all. */
  disconnected: PersonSummary[];
  /** Everyone drawn: reachable from you, plus the disconnected. */
  nodeIds: string[];
  links: NetworkLink[];
}

export function buildBridges(people: readonly PersonSummary[], links: readonly NetworkLink[]): BridgeModel {
  const me = findMe(people);
  const live = links.filter((l) => !l.ended);
  if (!me) return { me: null, dependencies: [], disconnected: [], nodeIds: [], links: [] };
  const byId = new Map(people.map((p) => [p.id, p]));
  const adj = new Map<string, Set<string>>();
  for (const p of people) adj.set(p.id, new Set());
  for (const l of live) {
    if (!adj.has(l.source) || !adj.has(l.target) || l.source === l.target) continue;
    adj.get(l.source)!.add(l.target);
    adj.get(l.target)!.add(l.source);
  }
  const reach = (skip: string | null): Set<string> => {
    const seen = new Set([me.id]);
    const stack = [me.id];
    while (stack.length) {
      const x = stack.pop()!;
      for (const y of adj.get(x) ?? []) if (y !== skip && !seen.has(y)) { seen.add(y); stack.push(y); }
    }
    return seen;
  };
  const all = reach(null);
  const dependencies: Dependence[] = [];
  for (const id of all) {
    if (id === me.id) continue;
    const without = reach(id);
    const cut = [...all].filter((x) => x !== id && !without.has(x)).map((x) => byId.get(x)!).sort((a, b) => a.name.localeCompare(b.name));
    if (cut.length > 0) dependencies.push({ person: byId.get(id)!, cutOff: cut });
  }
  dependencies.sort((a, b) => b.cutOff.length - a.cutOff.length || a.person.name.localeCompare(b.person.name));
  const disconnected = people.filter((p) => !all.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  return { me, dependencies, disconnected, nodeIds: [...all, ...disconnected.map((p) => p.id)], links: live };
}
