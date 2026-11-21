"use client";

/**
 * People view (People layer, W5).
 * A list of the people you work with, grouped by their relationship to you
 * (or by team, place, when you last met, or name), with a suggestions tray
 * for people capture proposed, and the selected person's page beside it. The
 * picture modes open a person or a team in their own side panel.
 * Plan: docs/plans/people-layer.md ("People view").
 *
 * Left for later: live title/local time, next meeting and open items on each
 * row (W6/W4), and the first-use hint that offers to turn the view on.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Check, ExternalLink, Globe, List, Lock, Map as MapIcon, Network, Plus, Search, Share2, Users, UsersRound, X, Workflow } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { onChangeFeed } from "@/store/change-feed";
import { ViewToolbar } from "@/components/ui/view-toolbar";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { OpenPersonContext } from "@/components/graph/peopleCanvasShared";
import { OrgChartCanvas } from "@/components/graph/OrgChartCanvas";
import { RelationshipCanvas } from "@/components/graph/RelationshipCanvas";
import { SectionLabel } from "@/components/ui/labels";
import { EmptyState } from "@/components/ui/empty-state";
import { formatRelative } from "../../../shared/format/date";
import { cn } from "@/lib/utils";
import { RELATIONSHIP_TYPES, type RelationshipType } from "../../../shared/types/people";
import type { PersonSummary } from "../../../shared/types/people-view";
import { PEOPLE_GROUPS, RELATIONSHIP_LABELS, type PeopleGroupKey } from "./people-model";
import { LIST_GROUPINGS, groupPeopleBy, type ListGrouping } from "../../../shared/people/list-groups";
import { PersonAvatar } from "./PersonAvatar";
import { TeamPage } from "./TeamPage";
import { PersonPage } from "./PersonPage";
import { MigrationPanel } from "./MigrationPanel";
import { PersonPanel } from "./PersonPanel";
import { TeamsCanvas } from "./TeamsCanvas";
import { TimeZonesCanvas } from "./TimeZonesCanvas";
import { RhythmCanvas } from "./RhythmCanvas";
import { BridgesCanvas } from "./BridgesCanvas";
import { MapCanvas } from "./MapCanvas";
import { useNow } from "@/lib/viz/hooks";

export type PeopleMode = "list" | "org" | "relationships" | "teams" | "zones" | "rhythm" | "bridges" | "map";

const MODES = [
  { value: "list" as const, label: "List", icon: <List size={12} /> },
  { value: "org" as const, label: "Org chart", icon: <Workflow size={12} /> },
  { value: "relationships" as const, label: "Relationships", icon: <Network size={12} /> },
  { value: "teams" as const, label: "Teams", icon: <UsersRound size={12} /> },
  { value: "zones" as const, label: "Time zones", icon: <Globe size={12} /> },
  { value: "rhythm" as const, label: "Rhythm", icon: <CalendarClock size={12} /> },
  { value: "bridges" as const, label: "Bridges", icon: <Share2 size={12} /> },
  { value: "map" as const, label: "Map", icon: <MapIcon size={12} /> },
];

// ── List ────────────────────────────────────────────────────────────────────

export function PersonRow({ person, selected, onSelect, hideTeam = false }: { person: PersonSummary; selected: boolean; onSelect: () => void; hideTeam?: boolean }) {
  const sub = [person.title, hideTeam ? null : person.team].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
        FOCUS_RING,
        selected ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-primary)] hover:bg-[var(--surface-2)]",
      )}
    >
      <PersonAvatar name={person.name} isMe={person.isMe} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{person.name}</span>
        {sub && <span className="block truncate text-2xs text-[var(--text-tertiary)]">{sub}</span>}
      </span>
      {person.agentPrivate && <Lock size={11} className="text-[var(--text-tertiary)] flex-shrink-0" aria-label="Private from agents" />}
      <span className="text-2xs text-[var(--text-tertiary)] flex-shrink-0 tabular-nums">
        {person.lastMetAt ? formatRelative(person.lastMetAt, { absoluteAfterDays: 30 }) : ""}
      </span>
    </button>
  );
}

const GROUPING_KEY = "people.listGrouping";
function readGrouping(): ListGrouping {
  try {
    const v = localStorage.getItem(GROUPING_KEY);
    return LIST_GROUPINGS.some((g) => g.value === v) ? (v as ListGrouping) : "relationship";
  } catch { return "relationship"; }
}
function writeGrouping(v: ListGrouping) {
  try { localStorage.setItem(GROUPING_KEY, v); } catch { /* per-viewer convenience only */ }
}

function SuggestionsTray({ suggestions }: { suggestions: PersonSummary[] }) {
  const { confirm, dismiss } = useCairnStore(useShallow((s) => ({
    confirm: s.confirmPersonSuggestion,
    dismiss: s.dismissPersonSuggestion,
  })));
  if (suggestions.length === 0) return null;
  return (
    <section aria-label="Suggested people" className="mb-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-2.5 shadow-elev-1">
      <SectionLabel className="block px-1 mb-1.5">Suggested people</SectionLabel>
      <ul className="space-y-1">
        {suggestions.map((p) => (
          <li key={p.id} className="flex items-center gap-1.5 px-1">
            <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">{p.name}</span>
            <IconButton label={`Confirm ${p.name}`} size="sm" onClick={() => void confirm(p.id)}><Check size={12} /></IconButton>
            <IconButton label={`Dismiss ${p.name}`} size="sm" onClick={() => void dismiss(p.id)}><X size={12} /></IconButton>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CreatePersonForm({ onDone }: { onDone: (id: string | null) => void }) {
  const createPerson = useCairnStore((s) => s.createPerson);
  const [name, setName] = useState("");
  const [rel, setRel] = useState<RelationshipType | "none">("none");
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current || !name.trim()) return;
    inFlight.current = true;
    try {
      const created = await createPerson({
        name,
        relationship: rel === "none" ? [] : [{ type: rel, provenance: "explicit" }],
      });
      onDone(created?.id ?? null);
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <form
      aria-label="Add a person"
      className="mb-4 space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-2.5 shadow-elev-1"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
    >
      <Input autoFocus aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className="text-xs" />
      <Select<RelationshipType | "none">
        ariaLabel="Relationship to you"
        value={rel}
        className="w-full"
        options={[{ value: "none", label: "No relationship yet" }, ...RELATIONSHIP_TYPES.map((t) => ({ value: t, label: RELATIONSHIP_LABELS[t] }))]}
        onChange={setRel}
      />
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="xs" onClick={() => onDone(null)}>Cancel</Button>
        <Button type="submit" variant="accent" size="xs" disabled={!name.trim()}>Add person</Button>
      </div>
    </form>
  );
}

// ── View ────────────────────────────────────────────────────────────────────

export function PeopleView() {
  const {
    activeWorkspaceId, people, suggestions, loaded, selectedPersonId, personPage, loadPeople, refreshPeople, selectPerson,
  } = useCairnStore(useShallow((s) => ({
    activeWorkspaceId: s.activeWorkspaceId,
    people: s.people,
    suggestions: s.peopleSuggestions,
    loaded: s.peopleLoaded,
    selectedPersonId: s.selectedPersonId,
    personPage: s.personPage,
    loadPeople: s.loadPeople,
    refreshPeople: s.refreshPeople,
    selectPerson: s.selectPerson,
  })));
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<PeopleGroupKey | "all">("all");
  const [creating, setCreating] = useState(false);
  const [finding, setFinding] = useState(false);
  const [mode, setMode] = useState<PeopleMode>("list");
  const [grouping, setGroupingState] = useState<ListGrouping>(readGrouping);
  const setGrouping = (g: ListGrouping) => { setGroupingState(g); writeGrouping(g); };
  // The picture views keep their own side panel (a person or a team); the list keeps the store selection.
  const [panel, setPanel] = useState<{ kind: "person" | "team"; id: string } | null>(null);
  const panelId = panel?.kind === "person" ? panel.id : null;
  const openPanelPerson = React.useCallback((id: string | null) => setPanel(id ? { kind: "person", id } : null), []);
  const openPanelTeam = React.useCallback((name: string) => setPanel({ kind: "team", id: name }), []);
  const changeMode = (m: PeopleMode) => { setMode(m); setPanel(null); };
  const inList = mode === "list";

  // Load on open and on workspace switch (people are workspace-wide). Don't clear the
  // selection here: openPerson sets it before this view mounts, and a workspace switch
  // already clears it in the store.
  useEffect(() => {
    void loadPeople();
  }, [activeWorkspaceId, loadPeople]);

  // Reopening People from the sidebar starts at the list, not at the last person. Clear on the
  // move away, not in an effect cleanup: Strict Mode runs that cleanup on mount and would drop
  // the person openPerson just selected.
  useEffect(() => useCairnStore.subscribe((state, prev) => {
    if (prev.activeView === "people" && state.activeView !== "people") selectPerson(null);
  }), [selectPerson]);

  // People tables aren't in the change feed's entity set, so refresh on any
  // change (sync, an agent over MCP). Both reads are cheap.
  useEffect(() => onChangeFeed(() => { void refreshPeople(); }), [refreshPeople]);

  // Location and Last met read the clock, so the grouping is redone each minute.
  const now = useNow(60_000);
  const groups = useMemo(
    () => groupPeopleBy(people, grouping, { query, only: only === "all" ? null : only, now: new Date(now) }),
    [people, grouping, query, only, now],
  );

  const filtered = query.trim() !== "" || only !== "all";

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {finding && <MigrationPanel key={activeWorkspaceId} onClose={() => setFinding(false)} />}
      <ViewToolbar
        title="People"
        description="The people you work with, their meetings and notes"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setFinding(true)}>Find people in notes</Button>
            <Button size="sm" variant="outline" onClick={() => { changeMode("list"); setCreating(true); }} disabled={creating && inList}>
              <Plus size={12} /> Add person
            </Button>
          </>
        }
      >
        <SegmentedControl<PeopleMode> ariaLabel="People view" size="sm" options={MODES} value={mode} onChange={changeMode} />
      </ViewToolbar>

      {!inList && (
        <OpenPersonContext.Provider value={openPanelPerson}>
          <div className="flex flex-1 min-h-0">
            <div className="@container flex flex-1 min-w-0 min-h-0 flex-col">
              {mode === "org" && <OrgChartCanvas onOpenTeam={openPanelTeam} />}
              {mode === "relationships" && <RelationshipCanvas />}
              {mode === "teams" && <TeamsCanvas people={people} selectedTeam={panel?.kind === "team" ? panel.id : null} onOpenTeam={openPanelTeam} />}
              {mode === "zones" && <TimeZonesCanvas people={people} selectedId={panelId} />}
              {mode === "rhythm" && <RhythmCanvas people={people} selectedId={panelId} />}
              {mode === "bridges" && <BridgesCanvas selectedId={panelId} />}
              {mode === "map" && <MapCanvas people={people} selectedId={panelId} />}
            </div>
            {panel && (
              <aside aria-label={panel.kind === "team" ? "Team" : "Person"} className="w-[26rem] max-w-[45%] flex-shrink-0 border-l border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-3 h-10 border-b border-[var(--border)] flex-shrink-0">
                  <span className="text-xs font-medium text-[var(--text-secondary)]">{panel.kind === "team" ? "Team" : "Person"}</span>
                  <div className="flex items-center gap-1">
                    {panel.kind === "person" && (
                      <Button variant="ghost" size="xs" onClick={() => { const id = panel.id; setMode("list"); setPanel(null); selectPerson(id); }}>
                        <ExternalLink size={11} /> Open in list
                      </Button>
                    )}
                    <IconButton label={panel.kind === "team" ? "Close team" : "Close person"} onClick={() => setPanel(null)}><X size={13} /></IconButton>
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-auto">
                  {panel.kind === "person" ? (
                    <PersonPanel key={panel.id} personId={panel.id} />
                  ) : (
                    <TeamPage
                      key={panel.id} name={panel.id}
                      onOpenPerson={openPanelPerson} onOpenTeam={openPanelTeam}
                      onGone={(renamed) => setPanel(renamed ? { kind: "team", id: renamed } : null)}
                    />
                  )}
                </div>
              </aside>
            )}
          </div>
        </OpenPersonContext.Provider>
      )}

      {inList && <div className="flex flex-1 min-h-0">
        <aside aria-label="People" className="w-72 flex-shrink-0 overflow-y-auto border-r border-[var(--border)] p-3">
          <div className="mb-3 space-y-1.5">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none" aria-hidden />
              <Input
                aria-label="Search people"
                placeholder="Search people"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-7 py-1 text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Select<ListGrouping>
                ariaLabel="Group by"
                value={grouping}
                className="w-full"
                options={LIST_GROUPINGS.map((g) => ({ value: g.value, label: `By ${g.label.toLowerCase()}` }))}
                onChange={setGrouping}
              />
              <Select<PeopleGroupKey | "all">
                ariaLabel="Filter by relationship"
                value={only}
                className="w-full"
                options={[{ value: "all", label: "Everyone" }, ...PEOPLE_GROUPS.map((g) => ({ value: g.key, label: g.label }))]}
                onChange={setOnly}
              />
            </div>
          </div>
          {creating && (
            <CreatePersonForm onDone={(id) => { setCreating(false); if (id) selectPerson(id); }} />
          )}
          <SuggestionsTray suggestions={suggestions} />
          {loaded && people.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No people yet"
              description="Add the people you work with, let meetings and agents suggest them, or find the person notes you already have."
              action={!creating ? <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus size={12} /> Add person</Button> : undefined}
              className="py-10"
            />
          ) : groups.length === 0 && filtered ? (
            <p className="px-2.5 py-4 text-xs text-[var(--text-tertiary)]">Nobody matches.</p>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <section key={g.key} aria-label={g.label}>
                  <div className="flex items-baseline gap-2 px-2 mb-1">
                    <SectionLabel>{g.label}</SectionLabel>
                    <span className="text-2xs text-[var(--text-tertiary)] tabular-nums">{g.people.length}</span>
                    {"note" in g && g.note && <span className="ml-auto text-2xs text-[var(--text-tertiary)] tabular-nums">{g.note} local</span>}
                  </div>
                  <div className="space-y-0.5">
                    {g.people.map((p) => (
                      <PersonRow key={`${g.key}:${p.id}`} person={p} hideTeam={grouping === "team"} selected={p.id === selectedPersonId} onSelect={() => selectPerson(p.id)} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto">
          {selectedPersonId ? (
            <PersonPage key={selectedPersonId} page={personPage} />
          ) : (
            <EmptyState
              icon={Users}
              title="Choose a person"
              description="Their meetings, the notes that mention them and their persona note show here."
              className="h-full"
            />
          )}
        </main>
      </div>}
    </div>
  );
}
