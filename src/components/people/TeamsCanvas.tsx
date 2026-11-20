"use client";

/**
 * People view, "Teams": everyone grouped by the team recorded on them, largest
 * team first. Each card says how the team relates to you and how spread out it
 * is across time zones; a name opens the person. Nothing here counts activity.
 */
import React, { useMemo } from "react";
import { Users } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useOpenPerson } from "@/components/graph/peopleCanvasShared";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "@/components/ui/button";
import { NO_TEAM, groupByTeam } from "../../../shared/people/teams";
import { RELATIONSHIP_LABELS } from "./people-model";
import type { PersonSummary } from "../../../shared/types/people-view";
import type { RelationshipType } from "../../../shared/types/people";

const ORDER: RelationshipType[] = ["manager", "direct_report", "peer", "stakeholder", "mentor", "buddy", "candidate"];

export function TeamsCanvas({ people, selectedId }: { people: readonly PersonSummary[]; selectedId?: string | null }) {
  const open = useOpenPerson();
  const teams = useMemo(() => groupByTeam(people), [people]);
  const named = teams.filter((t) => t.team !== NO_TEAM).length;

  if (people.length === 0) return <EmptyState icon={Users} title="No people yet" description="Add the people you work with and their teams show up here." className="h-full" />;
  return (
    <div className="h-full overflow-y-auto p-4">
      {named === 0 && (
        <p role="status" className="mb-3 text-xs text-[var(--text-tertiary)]">
          Nobody has a team yet. Set one on a person&apos;s page, or ask the assistant to fill it in.
        </p>
      )}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
        {teams.map((t) => {
          const rels = ORDER.filter((r) => t.byRelationship[r]).map((r) => `${t.byRelationship[r]} ${RELATIONSHIP_LABELS[r].toLowerCase()}`);
          return (
            <section key={t.team} aria-label={t.team} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3 shadow-elev-1">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="truncate text-sm font-medium text-[var(--text-primary)]">{t.team}</h3>
                <span className="text-2xs text-[var(--text-tertiary)] tabular-nums">{t.people.length}</span>
              </div>
              {(rels.length > 0 || t.timezones.length > 1) && (
                <p className="mt-0.5 text-2xs text-[var(--text-tertiary)]">
                  {[rels.join(" · "), t.timezones.length > 1 ? `${t.timezones.length} time zones` : ""].filter(Boolean).join(" · ")}
                </p>
              )}
              <ul className="mt-2 flex flex-wrap gap-1">
                {t.people.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button" onClick={() => open(p.id)} aria-pressed={p.id === selectedId}
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-xs transition-colors", FOCUS_RING,
                        p.id === selectedId ? "border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]" : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]",
                      )}
                    >
                      {p.name}{p.isMe ? " (you)" : ""}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
