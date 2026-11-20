"use client";

/**
 * People view, "Teams": every team as a card, nested under the team it sits
 * in. A card says what the team owns, who leads it, who is on it and how
 * spread out it is; it opens the team's page beside the view, where the
 * details can be edited. People without a team are listed last. Nothing here
 * counts activity.
 */
import React, { useMemo, useState } from "react";
import { ChevronRight, Hash, Plus, Users } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { EmptyState } from "@/components/ui/empty-state";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PanelHeading } from "@/components/ui/panel";
import { useOpenPerson } from "@/components/graph/peopleCanvasShared";
import { cn } from "@/lib/utils";
import { PeopleCanvasPage } from "./PeopleCanvasPage";
import { AvatarStack, PersonAvatar } from "./PersonAvatar";
import { NO_TEAM, groupByTeam, peopleUnder, teamForest, type TeamNode } from "../../../shared/people/teams";
import type { PersonSummary } from "../../../shared/types/people-view";

const same = (a: string | null | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

function TeamCard({ node, selected, onOpen, showPath }: { node: TeamNode; selected: boolean; onOpen: () => void; showPath: boolean }) {
  const people = useCairnStore((s) => s.people);
  const { group, path, children } = node;
  const info = group.info;
  const lead = info?.leadPersonId ? people.find((p) => p.id === info.leadPersonId) : undefined;
  const everyone = children.length ? peopleUnder(node) : group.people;
  const meta = [
    children.length ? `${group.people.length} here, ${everyone.length} in all` : `${group.people.length} ${group.people.length === 1 ? "person" : "people"}`,
    group.timezones.length > 1 ? `${group.timezones.length} time zones` : null,
  ].filter(Boolean).join(" · ");
  return (
    <button
      type="button" onClick={onOpen} aria-pressed={selected}
      className={cn(
        "group flex h-full w-full flex-col rounded-lg border bg-[var(--surface-2)] p-3.5 text-left shadow-elev-1 transition-[box-shadow,border-color] hover:shadow-elev-2",
        FOCUS_RING,
        selected ? "border-[var(--accent)]" : "border-[var(--border-subtle)]",
      )}
    >
      {showPath && path.length > 0 && (
        <span className="mb-0.5 flex items-center gap-0.5 truncate text-2xs text-[var(--text-tertiary)]">
          {path.join(" › ")}<ChevronRight size={10} aria-hidden />
        </span>
      )}
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate font-display text-lg leading-tight text-[var(--text-primary)]">{group.team}</span>
        {info?.channel && (
          <span className="inline-flex flex-shrink-0 items-center text-2xs text-[var(--text-tertiary)]"><Hash size={10} aria-hidden />{info.channel.replace(/^#/, "")}</span>
        )}
      </span>
      <span className={cn("mt-1 line-clamp-2 text-xs leading-relaxed", info?.description ? "text-[var(--text-secondary)]" : "text-[var(--text-tertiary)]")}>
        {info?.description || "No details yet"}
      </span>
      <span className="mt-auto pt-3 flex items-center justify-between gap-2">
        <AvatarStack people={group.people} max={6} />
        {lead && (
          <span className="inline-flex min-w-0 items-center gap-1 text-2xs text-[var(--text-tertiary)]">
            <span className="truncate">Lead {lead.name.split(" ")[0]}</span>
          </span>
        )}
      </span>
      <span className="mt-1.5 text-2xs text-[var(--text-tertiary)]">{meta}</span>
    </button>
  );
}

function NewTeam({ onCreated }: { onCreated: (name: string) => void }) {
  const createTeam = useCairnStore((s) => s.createTeam);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open) return <Button size="xs" variant="outline" onClick={() => setOpen(true)}><Plus size={12} /> New team</Button>;
  return (
    <form
      className="flex items-center gap-1.5" aria-label="New team"
      onSubmit={async (e) => {
        e.preventDefault();
        const t = name.trim() ? await createTeam({ name }) : null;
        if (t) { setOpen(false); setName(""); onCreated(t.name); }
      }}
    >
      <Input autoFocus aria-label="Team name" placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} className="w-44 py-1 text-xs"
        onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setName(""); } }} />
      <Button type="submit" size="xs" variant="accent" disabled={!name.trim()}>Add</Button>
      <Button type="button" size="xs" variant="ghost" onClick={() => { setOpen(false); setName(""); }}>Cancel</Button>
    </form>
  );
}

const GRID = "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(15.5rem,1fr))]";

export function TeamsCanvas({ people, selectedTeam, onOpenTeam }: {
  people: readonly PersonSummary[];
  selectedTeam?: string | null;
  onOpenTeam: (name: string) => void;
}) {
  const open = useOpenPerson();
  const { teams, selectedPersonId } = useCairnStore(useShallow((s) => ({ teams: s.teams, selectedPersonId: s.selectedPersonId })));
  const groups = useMemo(() => groupByTeam(people, teams), [people, teams]);
  const forest = useMemo(() => teamForest(groups), [groups]);
  const loose = groups.find((g) => g.team === NO_TEAM)?.people ?? [];

  if (people.length === 0 && teams.length === 0) {
    return <EmptyState icon={Users} title="No people yet" description="Add the people you work with and their teams show up here." className="h-full" />;
  }

  // A tree with teams under it is a section of its own; teams that stand alone share one grid.
  const nested = forest.filter((n) => n.children.length > 0);
  const single = forest.filter((n) => n.children.length === 0);
  const card = (n: TeamNode, showPath = false) => (
    <li key={n.group.team}>
      <TeamCard node={n} showPath={showPath} selected={!!selectedTeam && same(selectedTeam, n.group.team)} onOpen={() => onOpenTeam(n.group.team)} />
    </li>
  );
  const descendants = (n: TeamNode): TeamNode[] => n.children.flatMap((c) => [c, ...descendants(c)]);

  return (
    <PeopleCanvasPage lede="Who works on what. Each team says what it owns and who leads it; open one to fill in the details or move people between teams.">
      {forest.length === 0 && (
        <p role="status" className="mb-6 text-xs text-[var(--text-tertiary)]">
          Nobody has a team yet. Start one here, set a team on a person&apos;s page, or ask the assistant to sort people into teams.
        </p>
      )}

      {nested.map((root, i) => (
        <section key={root.group.team} aria-label={root.group.team} className="mb-9">
          <PanelHeading
            title={root.group.team}
            note={`${descendants(root).length + 1} teams, ${peopleUnder(root).length} people`}
            action={i === 0 && single.length === 0 ? <NewTeam onCreated={onOpenTeam} /> : undefined}
          />
          <ul className={GRID}>
            {card(root)}
            {descendants(root).map((n) => card(n, n.path.length > 1))}
          </ul>
        </section>
      ))}

      {(single.length > 0 || nested.length === 0) && (
        <section aria-label="Teams" className="mb-9">
          <PanelHeading title={nested.length ? "Other teams" : "Teams"} note={single.length ? String(single.length) : undefined} action={<NewTeam onCreated={onOpenTeam} />} />
          {single.length > 0 && <ul className={GRID}>{single.map((n) => card(n))}</ul>}
        </section>
      )}

      {loose.length > 0 && (
        <section aria-label="Without a team">
          <PanelHeading title="Without a team" note={String(loose.length)} />
          <ul className="flex flex-wrap gap-1.5">
            {loose.map((p) => (
              <li key={p.id}>
                <button
                  type="button" onClick={() => open(p.id)} aria-pressed={p.id === selectedPersonId}
                  className={cn("inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] py-0.5 pl-0.5 pr-2.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]", FOCUS_RING)}
                >
                  <PersonAvatar name={p.name} isMe={p.isMe} size="xs" />{p.name}{p.isMe ? " (you)" : ""}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-2xs text-[var(--text-tertiary)]">Open a team and add them, or set a team on their page.</p>
        </section>
      )}
    </PeopleCanvasPage>
  );
}
