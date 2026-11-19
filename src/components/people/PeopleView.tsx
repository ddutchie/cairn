"use client";

/**
 * People view (People layer, W5; behind the `feature.people` flag).
 * A list of the people you work with, grouped by their relationship to you,
 * with a suggestions tray for people capture proposed, and the selected
 * person's page beside it. Plan: docs/plans/people-layer.md ("People view").
 *
 * Left for later: live title/local time, next meeting and open items on each
 * row (W6/W4), and the first-use hint that offers to turn the view on.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Lock, Plus, Search, Users, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { onChangeFeed } from "@/store/change-feed";
import { ViewToolbar } from "@/components/ui/view-toolbar";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SectionLabel } from "@/components/ui/labels";
import { EmptyState } from "@/components/ui/empty-state";
import { formatRelative } from "../../../shared/format/date";
import { cn } from "@/lib/utils";
import { RELATIONSHIP_TYPES, type RelationshipType } from "../../../shared/types/people";
import type { PersonSummary } from "../../../shared/types/people-view";
import { PEOPLE_GROUPS, RELATIONSHIP_LABELS, groupPeople, type PeopleGroupKey } from "./people-model";
import { PersonPage } from "./PersonPage";
import { MigrationPanel } from "./MigrationPanel";

// ── List ────────────────────────────────────────────────────────────────────

export function PersonRow({ person, selected, onSelect }: { person: PersonSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors",
        FOCUS_RING,
        selected ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-primary)] hover:bg-[var(--surface-2)]",
      )}
    >
      <span className="min-w-0 flex-1 truncate text-sm">{person.name}</span>
      {person.agentPrivate && <Lock size={11} className="text-[var(--text-tertiary)] flex-shrink-0" aria-label="Private from agents" />}
      {/* Slot (W6/W4): live title, local time, next meeting, open items. */}
      <span className="text-2xs text-[var(--text-tertiary)] flex-shrink-0 tabular-nums">
        {person.lastMetAt ? formatRelative(person.lastMetAt, { absoluteAfterDays: 30 }) : ""}
      </span>
    </button>
  );
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

  // Load on open and on workspace switch (people are workspace-wide).
  useEffect(() => {
    selectPerson(null);
    void loadPeople();
  }, [activeWorkspaceId, loadPeople, selectPerson]);

  // People tables aren't in the change feed's entity set, so refresh on any
  // change (sync, an agent over MCP). Both reads are cheap.
  useEffect(() => onChangeFeed(() => { void refreshPeople(); }), [refreshPeople]);

  const groups = useMemo(
    () => groupPeople(people, { query, only: only === "all" ? null : only }),
    [people, query, only],
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
            <Button size="sm" variant="ghost" onClick={() => setFinding(true)}>Find in notes</Button>
            <Button size="sm" variant="outline" onClick={() => setCreating(true)} disabled={creating}>
              <Plus size={12} /> Add person
            </Button>
          </>
        }
      >
        <div className="relative w-56 max-w-full">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none" aria-hidden />
          <Input
            aria-label="Search people"
            placeholder="Search people"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-7 py-1 text-xs"
          />
        </div>
        <Select<PeopleGroupKey | "all">
          ariaLabel="Filter by relationship"
          value={only}
          options={[{ value: "all", label: "Everyone" }, ...PEOPLE_GROUPS.map((g) => ({ value: g.key, label: g.label }))]}
          onChange={setOnly}
        />
      </ViewToolbar>

      <div className="flex flex-1 min-h-0">
        <aside aria-label="People" className="w-72 flex-shrink-0 overflow-y-auto border-r border-[var(--border)] p-3">
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
                  <div className="flex items-baseline gap-2 px-2.5 mb-1">
                    <SectionLabel>{g.label}</SectionLabel>
                    <span className="text-2xs text-[var(--text-tertiary)] tabular-nums">{g.people.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {g.people.map((p) => (
                      <PersonRow key={`${g.key}:${p.id}`} person={p} selected={p.id === selectedPersonId} onSelect={() => selectPerson(p.id)} />
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
      </div>
    </div>
  );
}
