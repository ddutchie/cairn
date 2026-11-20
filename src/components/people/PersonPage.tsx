"use client";

/**
 * The person page: header (name, relationship chips, cadence, edges), the
 * person's settings when editing, Timeline and Persona. Reads the page model
 * the store loads for the selected person (`personPage`).
 *
 * The 1:1 loop (W6) lives in `PersonOneOnOne.tsx`: live Slack fields under the
 * name and Next meeting with Prep. Deliberately left for later (slot marked
 * below): Open items both ways, and the attendee strip on meeting notes.
 */

import React, { useEffect, useRef, useState } from "react";
import { CalendarDays, CheckCircle2, FileText, Kanban, Lock, Pencil, Sparkles, X, AtSign } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Select } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Toggle } from "@/components/ui/toggle";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { PanelHeading } from "@/components/ui/panel";
import { MicroLabel } from "@/components/ui/labels";
import { EmptyState } from "@/components/ui/empty-state";
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";
import { MarkdownEditor } from "@/components/notes/markdown-editor";
import { revealCard, revealNote } from "@/lib/events";
import { formatDate, formatRelative } from "../../../shared/format/date";
import { cn } from "@/lib/utils";
import "../../../shared/people/place-data";
import { cleanProfileFieldWithPlaces, zoneForPlace } from "../../../shared/people/place-zone";
import { cleanRelationshipLabel, type ProfileField } from "../../../shared/people/parse";
import { CADENCES, RELATIONSHIP_TYPES, type Cadence, type RelationshipType } from "../../../shared/types/people";
import type { PersonPage as PersonPageModel, PersonTimelineItem } from "../../../shared/types/people-view";
import {
  CADENCE_LABELS, EDGE_ROLE_OPTIONS, RELATIONSHIP_LABELS, describeRelation, splitList,
} from "./people-model";
import { peopleClient } from "@/lib/ipc/people";
import { applicableFields, PROFILE_FIELD_LABEL, type AutofillProposal } from "../../../shared/people/autofill";
import { ConnectionsGraph } from "./ConnectionsGraph";
import { BlurInput, Field } from "./fields";
import { PlaceInput } from "./PlaceInput";
import { latestProfileValue, noteProfileWrite } from "./recent-profile-writes";
import { NextMeeting, ProfileLine, slackStatusText, usePersonProfile } from "./PersonOneOnOne";
import type { PersonProfile } from "../../../shared/people/oneonone";

/** Open a note or card in its project. */
function useReveal() {
  const { activeProjectId, setActiveProject, setView } = useCairnStore(useShallow((s) => ({
    activeProjectId: s.activeProjectId, setActiveProject: s.setActiveProject, setView: s.setView,
  })));
  return {
    note(projectId: string, noteId: string) {
      if (projectId !== activeProjectId) setActiveProject(projectId);
      revealNote(setView, noteId);
    },
    card(projectId: string, cardId: string) {
      if (projectId !== activeProjectId) setActiveProject(projectId);
      revealCard(setView, cardId);
    },
  };
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-secondary)]", className)}>
      {children}
    </span>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────

function PersonHeader({ page, profile, compact, editing, onToggleEdit }: { page: PersonPageModel; profile: PersonProfile | null; compact: boolean; editing: boolean; onToggleEdit: () => void }) {
  const { person, relations } = page;
  const facts = [
    person.cadence ? `${CADENCE_LABELS[person.cadence]} 1:1s` : null,
    page.lastMetAt ? `Last met ${formatRelative(page.lastMetAt, { absoluteAfterDays: 30 })}` : "No meetings yet",
  ].filter(Boolean);
  return (
    <header className="mb-8">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className={cn("font-display font-normal tracking-tight text-balance text-[var(--text-primary)] flex items-center gap-2", compact ? "text-xl leading-tight" : "text-3xl leading-[1.08]")}>
            <span className="truncate">{person.name}</span>
            {person.agentPrivate && (
              <Lock size={16} className="text-[var(--text-tertiary)] flex-shrink-0" aria-label="Private from agents" />
            )}
          </h1>
          {person.aliases.length > 0 && (
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">Also {person.aliases.join(", ")}</p>
          )}
        </div>
        <Button variant={editing ? "accent" : "outline"} size="sm" onClick={onToggleEdit} aria-pressed={editing}>
          <Pencil size={12} /> {editing ? "Done editing" : "Edit details"}
        </Button>
      </div>
      <ProfileLine profile={profile} person={person} />
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {person.relationship.map((r) => (
          <Chip key={`${r.type}|${r.label ?? ""}`}>
            {r.label ? `${RELATIONSHIP_LABELS[r.type]} · ${r.label}` : RELATIONSHIP_LABELS[r.type]}
          </Chip>
        ))}
        {person.stage && <Chip>Stage: {person.stage}</Chip>}
        <span className={cn("text-xs text-[var(--text-tertiary)]", (person.relationship.length > 0 || person.stage) && "ml-1")}>{facts.join(". ")}</span>
      </div>
      {relations.length > 0 && (
        <ul className="mt-3 space-y-0.5 text-sm text-[var(--text-secondary)]" aria-label="Relationships">
          {relations.map((r) => (
            <li key={r.edge.id} className={r.edge.endedAt ? "text-[var(--text-tertiary)]" : undefined}>{describeRelation(r)}</li>
          ))}
        </ul>
      )}
    </header>
  );
}

// ── Settings (editing) ──────────────────────────────────────────────────────

/** A role, team, place or time zone: one short line, saved on blur, with a message when it isn't valid. */
function ProfileInput({ field, personId, value, placeholder, timezone }: { field: ProfileField; personId: string; value: string; placeholder: string; timezone?: string }) {
  const updatePerson = useCairnStore((s) => s.updatePerson);
  const [error, setError] = useState<string | null>(null);
  const label = { title: "Role", team: "Team", location: "Location", timezone: "Time zone" }[field];
  const save = (v: string, picked?: string) => {
    const { value: clean, error: err } = cleanProfileFieldWithPlaces(field, v);
    setError(err ?? null);
    if (err) return;
    // A place that names a zone fills an empty time zone, never one that is set. "Set" is judged now, not from this render's
    // prop: a time zone saved a moment ago may not be in the list yet.
    let zone: string | null = null;
    if (field === "location") {
      const person = useCairnStore.getState().people.find((p) => p.id === personId);
      if (!latestProfileValue(personId, "timezone", person ? person.timezone : timezone)) zone = picked ?? zoneForPlace(clean);
    }
    noteProfileWrite(personId, field, clean ?? null);
    if (zone) noteProfileWrite(personId, "timezone", zone);
    void updatePerson(personId, { [field]: clean ?? null, ...(zone ? { timezone: zone } : {}) });
  };
  const suggests = field === "location" || field === "timezone";
  return (
    <>
      {suggests ? (
        // Keyed by the saved value, like BlurInput: a save or outside change starts a fresh draft.
        <PlaceInput key={value} mode={field} ariaLabel={label} placeholder={placeholder} value={value} onCommit={save} />
      ) : (
        <BlurInput ariaLabel={label} placeholder={placeholder} value={value} onSave={(v) => save(v)} />
      )}
      {error && <p role="alert" className="mt-1 text-2xs text-[var(--danger)]">{error}</p>}
    </>
  );
}

function PersonSettings({ page, profile }: { page: PersonPageModel; profile: PersonProfile | null }) {
  const { person, relations } = page;
  const { people, updatePerson, deletePerson, addPersonEdge, updatePersonEdge, removePersonEdge } = useCairnStore(useShallow((s) => ({
    people: s.people,
    updatePerson: s.updatePerson,
    deletePerson: s.deletePerson,
    addPersonEdge: s.addPersonEdge,
    updatePersonEdge: s.updatePersonEdge,
    removePersonEdge: s.removePersonEdge,
  })));
  const [edgeRole, setEdgeRole] = useState(EDGE_ROLE_OPTIONS[0].role);
  const [edgeOther, setEdgeOther] = useState<string | null>(null);

  const has = (t: RelationshipType) => person.relationship.some((r) => r.type === t);
  // Writes land after a round trip; build each change on the previous one so
  // two quick clicks (Peer, then Mentor) both stick.
  const pendingRel = useRef<{ list: typeof person.relationship; writes: number } | null>(null);
  // Toggles and label edits share this chain, so each write starts from the latest pending list.
  const writeRelationship = (change: (base: typeof person.relationship) => typeof person.relationship) => {
    const base = pendingRel.current?.list ?? person.relationship;
    const next = change(base);
    const pending = pendingRel.current ?? { list: next, writes: 0 };
    pending.list = next;
    pending.writes += 1;
    pendingRel.current = pending;
    void updatePerson(person.id, { relationship: next }).finally(() => {
      if (pendingRel.current && --pendingRel.current.writes === 0) pendingRel.current = null;
    });
  };
  const toggleRelationship = (t: RelationshipType) =>
    writeRelationship((base) => base.some((r) => r.type === t)
      ? base.filter((r) => r.type !== t)
      : [...base, { type: t, provenance: "explicit" as const }]);
  const [labelError, setLabelError] = useState<string | null>(null);

  const addEdge = () => {
    const opt = EDGE_ROLE_OPTIONS.find((o) => o.role === edgeRole);
    if (!opt || !edgeOther) return;
    void addPersonEdge({
      type: opt.type,
      sourceId: opt.thisIsSource ? person.id : edgeOther,
      targetId: opt.thisIsSource ? edgeOther : person.id,
    });
    setEdgeOther(null);
  };

  const others = people.filter((p) => p.id !== person.id);

  return (
    <section className="@container mb-9" aria-label="Person settings">
      <PanelHeading title="Settings" note="Saved as you change them" />
      <Field label="Name">
        <BlurInput ariaLabel="Name" value={person.name} onSave={(v) => { if (v.trim()) void updatePerson(person.id, { name: v }); }} />
      </Field>
      <Field label="Role">
        <ProfileInput field="title" personId={person.id} value={person.title ?? ""} placeholder="e.g. Senior Software Engineer" />
      </Field>
      <Field label="Teams">
        <PersonTeams personId={person.id} teams={person.teams} />
      </Field>
      <Field label="Location">
        <ProfileInput field="location" personId={person.id} value={person.location ?? ""} timezone={person.timezone} placeholder="e.g. Berlin, Germany" />
      </Field>
      <Field label="Time zone">
        <ProfileInput field="timezone" personId={person.id} value={person.timezone ?? ""} placeholder="e.g. Europe/Berlin, or a city" />
      </Field>
      <Field label="Slack id">
        <BlurInput
          ariaLabel="Slack id"
          placeholder="U0123ABCD, to show their Slack profile"
          value={person.slackId ?? ""}
          onSave={(v) => void updatePerson(person.id, { slackId: v.trim() || null })}
        />
        <p role="status" className="mt-1 text-2xs text-[var(--text-tertiary)]">{slackStatusText(profile, person.slackId)}</p>
      </Field>
      <Field label="Relationship to you">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Relationship to you">
          {RELATIONSHIP_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={has(t)}
              onClick={() => toggleRelationship(t)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                FOCUS_RING,
                has(t)
                  ? "border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]",
              )}
            >
              {RELATIONSHIP_LABELS[t]}
            </button>
          ))}
        </div>
        {labelError && <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{labelError}</p>}
        {person.relationship.map((r, i) => (
          <div key={`${r.type}-${i}`} className="mt-2 flex items-center gap-2">
            <span className="w-24 shrink-0 text-xs text-[var(--text-tertiary)]">{RELATIONSHIP_LABELS[r.type]}</span>
            <BlurInput
              ariaLabel={`Label for ${RELATIONSHIP_LABELS[r.type]}`}
              placeholder="Optional, e.g. Executive sponsor"
              value={r.label ?? ""}
              onSave={(v) => {
                const { label, error } = cleanRelationshipLabel(v.replace(/[,;]+/g, " "));
                // Too long: keep the saved label and say why.
                if (error) { setLabelError(error); return; }
                setLabelError(null);
                if ((label ?? "") === (r.label ?? "")) return;
                // This entry only: a person can hold the same type twice with different labels.
                writeRelationship((base) => {
                  const at = base.findIndex((x) => x.type === r.type && (x.label ?? "") === (r.label ?? ""));
                  return at < 0 ? base : base.map((x, j) => (j === at ? { ...x, label } : x));
                });
              }}
            />
          </div>
        ))}
      </Field>
      {has("candidate") && (
        <Field label="Stage">
          <BlurInput ariaLabel="Candidate stage" placeholder="e.g. Onsite" value={person.stage ?? ""} onSave={(v) => void updatePerson(person.id, { stage: v.trim() || null })} />
        </Field>
      )}
      <Field label="Cadence">
        <Select<Cadence | "none">
          ariaLabel="Meeting cadence"
          value={person.cadence ?? "none"}
          options={[{ value: "none", label: "No regular 1:1" }, ...CADENCES.map((c) => ({ value: c, label: CADENCE_LABELS[c] }))]}
          onChange={(v) => void updatePerson(person.id, { cadence: v === "none" ? null : v })}
        />
      </Field>
      <Field label="Aliases">
        <BlurInput ariaLabel="Aliases" placeholder="Comma separated, e.g. Seb" value={person.aliases.join(", ")} onSave={(v) => void updatePerson(person.id, { aliases: splitList(v) })} />
      </Field>
      <Field label="Emails">
        <BlurInput ariaLabel="Emails" placeholder="Comma separated" value={person.emails.join(", ")} onSave={(v) => void updatePerson(person.id, { emails: splitList(v) })} />
      </Field>
      <Field label="This is me">
        <div className="flex items-center gap-2 pt-1">
          <Toggle checked={person.isMe} onCheckedChange={(on) => void updatePerson(person.id, { isMe: on })} label="This is me" />
          <span className="text-xs text-[var(--text-tertiary)]">Relationships like direct report or peer link people to you on the map</span>
        </div>
      </Field>
      <Field label="Private from agents">
        <div className="flex items-center gap-2 pt-1">
          <Toggle checked={person.agentPrivate} onCheckedChange={(on) => void updatePerson(person.id, { agentPrivate: on })} label="Private from agents" />
          <span className="text-xs text-[var(--text-tertiary)]">Agents won&apos;t read their persona note</span>
        </div>
      </Field>
      <Field label="Links to others">
        <div className="space-y-1.5">
          {relations.map((r) => (
            <div key={r.edge.id} className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span className="min-w-0 flex-1 truncate">{describeRelation(r)}</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void updatePersonEdge(r.edge.id, { endedAt: r.edge.endedAt ? null : new Date().toISOString().slice(0, 10) })}
              >
                {r.edge.endedAt ? "Mark current" : "Mark former"}
              </Button>
              <IconButton label={`Remove "${describeRelation(r)}"`} size="sm" onClick={() => void removePersonEdge(r.edge.id)}>
                <X size={12} />
              </IconButton>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              ariaLabel="Relationship type"
              value={edgeRole}
              options={EDGE_ROLE_OPTIONS.map((o) => ({ value: o.role, label: o.label }))}
              onChange={setEdgeRole}
            />
            <Combobox
              ariaLabel="Other person"
              value={edgeOther}
              options={others.map((p) => ({ value: p.id, label: p.name, keywords: p.aliases.join(" ") }))}
              onChange={setEdgeOther}
              placeholder="Choose a person"
              emptyText="No other people yet"
            />
            <Button size="sm" variant="outline" disabled={!edgeOther} onClick={addEdge}>Add</Button>
          </div>
        </div>
      </Field>
      <MergeDuplicate personId={person.id} name={person.name} />
      <div className="pt-4">
        <ConfirmButton
          variant="outline"
          size="sm"
          confirmLabel={`Delete ${person.name}?`}
          onConfirm={() => void deletePerson(person.id)}
        >
          Delete person
        </ConfirmButton>
        <p className="mt-1.5 text-2xs text-[var(--text-tertiary)]">Their notes stay. Meetings and cards lose the link to them.</p>
      </div>
    </section>
  );
}

// ── Timeline ────────────────────────────────────────────────────────────────

function TimelineRow({ item }: { item: PersonTimelineItem }) {
  const reveal = useReveal();
  const when = formatDate(item.at);
  const rowCls = "flex gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3 shadow-elev-1";
  const linkCls = cn("text-left hover:underline underline-offset-2 rounded-sm", FOCUS_RING);
  if (item.kind === "meeting") {
    return (
      <li className={rowCls}>
        <CalendarDays size={14} className="mt-0.5 text-[var(--text-tertiary)] flex-shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <MicroLabel>Meeting, {when}</MicroLabel>
          <p className="text-sm font-medium text-[var(--text-primary)]">{item.meeting.title}</p>
          {item.with.length > 0 && (
            <p className="text-xs text-[var(--text-tertiary)]">With {item.with.map((w) => w.name).join(", ")}</p>
          )}
          {item.notes.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              {item.notes.map((n) => (
                <button key={n.id} type="button" onClick={() => reveal.note(n.projectId, n.id)} className={cn(linkCls, "inline-flex items-center gap-1 text-xs text-[var(--text-secondary)]")}>
                  <FileText size={11} aria-hidden /> {n.title}
                </button>
              ))}
            </div>
          )}
        </div>
      </li>
    );
  }
  if (item.kind === "mention") {
    return (
      <li className={rowCls}>
        <AtSign size={14} className="mt-0.5 text-[var(--text-tertiary)] flex-shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <MicroLabel>Mentioned, {when}</MicroLabel>
          <button type="button" onClick={() => reveal.note(item.note.projectId, item.note.id)} className={cn(linkCls, "block text-sm font-medium text-[var(--text-primary)]")}>
            {item.note.title}
          </button>
        </div>
      </li>
    );
  }
  return (
    <li className={rowCls}>
      {item.card.done
        ? <CheckCircle2 size={14} className="mt-0.5 text-[var(--success)] flex-shrink-0" aria-hidden />
        : <Kanban size={14} className="mt-0.5 text-[var(--text-tertiary)] flex-shrink-0" aria-hidden />}
      <div className="min-w-0 flex-1">
        <MicroLabel>Owns a task, {when}</MicroLabel>
        <button type="button" onClick={() => reveal.card(item.card.projectId, item.card.id)} className={cn(linkCls, "block text-sm font-medium text-[var(--text-primary)]")}>
          {item.card.title}
        </button>
        {item.card.columnName && (
          <p className={cn("text-xs", item.card.done ? "text-[var(--success)]" : "text-[var(--text-tertiary)]")}>{item.card.columnName}</p>
        )}
      </div>
    </li>
  );
}

function Timeline({ items }: { items: PersonTimelineItem[] }) {
  return (
    <section className="mb-9" aria-label="Timeline">
      <PanelHeading title="Timeline" note={items.length ? undefined : "Nothing yet"} />
      {items.length === 0 ? (
        <p className="text-xs text-[var(--text-tertiary)]">
          Meetings they attend, notes that mention them and tasks they own show up here.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((item) => (
            <TimelineRow key={`${item.kind}:${item.kind === "meeting" ? item.meeting.id : item.kind === "mention" ? item.note.id : item.card.id}`} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Persona ─────────────────────────────────────────────────────────────────

// ── Autofill from the persona note ───────────────────────────────────────────

const SKIP_TEXT: Record<string, string> = {
  off: "The People layer is off.",
  "no-ai": "Connect an AI provider in Settings to use this.",
  private: "This person is private to you, so their note isn't sent to an AI.",
  "no-persona": "Link a persona note first.",
  empty: "The persona note is empty.",
  failed: "Couldn't read the note. Try again.",
};

/** Asks the model what the persona note says about role, team, location and time zone; the user ticks what to keep. */
function PersonaAutofill({ personId }: { personId: string }) {
  const updatePerson = useCairnStore((s) => s.updatePerson);
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "busy" } | { kind: "none"; message: string } | { kind: "review"; proposals: AutofillProposal[] }
  >({ kind: "idle" });
  const [picked, setPicked] = useState<Set<ProfileField>>(new Set());

  const run = async () => {
    setState({ kind: "busy" });
    try {
      const res = await peopleClient.autofill(personId);
      if ("skipped" in res) return setState({ kind: "none", message: SKIP_TEXT[res.skipped] ?? "Nothing to fill." });
      if (res.proposals.length === 0) return setState({ kind: "none", message: "The note says nothing new about these fields." });
      // Empty fields start ticked; replacing a value is the user's choice.
      setPicked(new Set(res.proposals.filter((p) => !p.current).map((p) => p.field)));
      setState({ kind: "review", proposals: res.proposals });
    } catch {
      setState({ kind: "none", message: SKIP_TEXT.failed });
    }
  };
  const apply = async () => {
    if (state.kind !== "review") return;
    // The person may have changed since the review (an edit, sync): leave those fields alone.
    // If we can't tell, write nothing.
    const latest = await peopleClient.get(personId).catch(() => null);
    if (!latest) return setState({ kind: "none", message: "Couldn't check the person first. Try again." });
    const { patch, changed } = applicableFields(state.proposals, (f) => picked.has(f), latest);
    if (Object.keys(patch).length) await updatePerson(personId, patch);
    setState(changed ? { kind: "none", message: `${changed === 1 ? "One field was" : `${changed} fields were`} changed meanwhile and left alone. Run it again to review.` } : { kind: "idle" });
  };

  return (
    <div className="mb-3">
      <Button variant="ghost" size="xs" onClick={run} disabled={state.kind === "busy"}>
        <Sparkles size={11} /> {state.kind === "busy" ? "Reading…" : "Fill details from note"}
      </Button>
      {state.kind === "none" && <p role="status" className="mt-1.5 text-xs text-[var(--text-tertiary)]">{state.message}</p>}
      {state.kind === "review" && (
        <div aria-label="Proposed details" className="mt-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <ul className="space-y-2">
            {state.proposals.map((p) => (
              <li key={p.field}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={picked.has(p.field)}
                    onChange={(e) => setPicked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(p.field); else n.delete(p.field); return n; })}
                  />
                  <span className="min-w-0">
                    <span className="text-[var(--text-tertiary)]">{PROFILE_FIELD_LABEL[p.field]}: </span>
                    <span className="text-[var(--text-primary)]">{p.value}</span>
                    {p.current && <span className="text-xs text-[var(--text-tertiary)]"> (now {p.current})</span>}
                    <span className="block truncate text-xs text-[var(--text-tertiary)]" title={p.quote}>“{p.quote}”</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button variant="accent" size="xs" onClick={apply} disabled={picked.size === 0}>Apply</Button>
            <Button variant="ghost" size="xs" onClick={() => setState({ kind: "idle" })}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Persona({ page }: { page: PersonPageModel }) {
  const updateNote = useCairnStore((s) => s.updateNote);
  const { persona } = page;
  const [draft, setDraft] = useState<string | null>(null);
  // Our own save, shown until the page model catches up (it is read from the
  // database, which the note write reaches a moment later).
  const [saved, setSaved] = useState<{ base: string; content: string } | null>(null);
  const content = persona ? (saved && saved.base === persona.content ? saved.content : persona.content) : "";
  const draftRef = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = (text: string) => {
    if (!persona || text === content) return;
    updateNote(persona.id, { content: text });
    setSaved({ base: persona.content, content: text });
  };
  const edit = (text: string) => {
    draftRef.current = text;
    setDraft(text);
    // Keep what's typed even if the page is left mid-edit.
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (draftRef.current !== null) save(draftRef.current); }, 1200);
  };
  const done = () => {
    if (timer.current) clearTimeout(timer.current);
    if (draft !== null) save(draft);
    draftRef.current = null;
    setDraft(null);
  };
  // Leaving the page (another person, another view) saves a pending edit.
  const pending = useRef({ save, persona });
  useEffect(() => { pending.current = { save, persona }; });
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (draftRef.current !== null) pending.current.save(draftRef.current);
  }, []);

  return (
    <section className="mb-9" aria-label="Persona">
      <PanelHeading
        title="Persona"
        note={persona ? persona.title : undefined}
        action={persona ? (
          draft === null ? (
            <Button variant="ghost" size="xs" onClick={() => setDraft(content)}>
              <Pencil size={11} /> Edit persona
            </Button>
          ) : (
            <Button variant="accent" size="xs" onClick={done}>Done</Button>
          )
        ) : undefined}
      />
      {persona && draft === null && <PersonaAutofill personId={page.person.id} />}
      {persona ? (
        draft !== null ? (
          <div aria-label="Persona note" className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">
            <MarkdownEditor
              initialValue={content}
              onChange={edit}
              livePreview
              placeholder="What they care about, how they like to work, how to help them grow"
            />
          </div>
        ) : content.trim()
          ? <NoteMarkdownPreview content={content} inline wikilinks className="text-sm" />
          : <p className="text-xs text-[var(--text-tertiary)]">The persona note is empty.</p>
      ) : (
        // Slot (W5 part 2): link or convert a note to this person's persona.
        <p className="text-xs text-[var(--text-tertiary)]">No persona note linked yet.</p>
      )}
    </section>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

/** Keyed by person id in PeopleView, so each person opens in read mode. */
export function PersonPage({ page, compact = false }: { page: PersonPageModel | null; compact?: boolean }) {
  if (!page) {
    return <EmptyState title="Loading" className="py-16" />;
  }
  return <PersonPageBody page={page} compact={compact} />;
}

/**
 * The teams someone is on, each removable (kept as history), plus adding them
 * to another; joining never takes them off a team, so moving is take off and
 * add. Past teams are listed under, quietly.
 */
function PersonTeams({ personId, teams }: { personId: string; teams: PersonPageModel["person"]["teams"] }) {
  const { allTeams, memberships, updatePerson, addTeamMember, endTeamMember } = useCairnStore(useShallow((s) => ({
    allTeams: s.teams, memberships: s.teamMemberships, updatePerson: s.updatePerson, addTeamMember: s.addTeamMember, endTeamMember: s.endTeamMember,
  })));
  const current = new Set(teams.map((t) => t.teamId));
  const byId = new Map(allTeams.map((t) => [t.id, t]));
  const past = memberships.filter((m) => m.personId === personId && m.endedAt && !current.has(m.teamId) && byId.has(m.teamId));
  return (
    <div className="space-y-1.5">
      {teams.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Their teams">
          {teams.map((t) => (
            <li key={t.teamId} className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border-subtle)] py-0.5 pl-2.5 pr-0.5 text-xs text-[var(--text-secondary)]">
              {t.name}
              {(t.role || t.kind !== "team") && <span className="text-2xs text-[var(--text-tertiary)]">&nbsp;· {t.role ?? t.kind}</span>}
              <IconButton label={`Take them off ${t.name}`} size="sm" onClick={() => void endTeamMember(t.teamId, personId)}><X size={11} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {allTeams.some((t) => !current.has(t.id)) && (
          <Combobox<string>
            ariaLabel="Add to a team" value={null} size="sm" placeholder="Add to a team" searchPlaceholder="Find a team"
            options={allTeams.filter((t) => !current.has(t.id)).map((t) => ({ value: t.id, label: t.name, description: t.kind !== "team" ? t.kind : undefined }))}
            onChange={(teamId) => void addTeamMember({ teamId, personId })}
          />
        )}
        <div className="min-w-0 flex-1">
          <BlurInput ariaLabel="Move to a new team" placeholder={teams.length ? "Or move to a new team" : "e.g. Sync"} value="" onSave={(v) => { if (v.trim()) void updatePerson(personId, { team: v }); }} />
        </div>
      </div>
      {past.length > 0 && (
        <p className="text-2xs text-[var(--text-tertiary)]">
          Before: {past.map((m) => `${byId.get(m.teamId)!.name} (until ${formatDate(m.endedAt!)})`).join(", ")}
        </p>
      )}
    </div>
  );
}

/** Fold a duplicate into this person: pick them, then confirm. */
function MergeDuplicate({ personId, name }: { personId: string; name: string }) {
  const { people, suggestions, mergePeople } = useCairnStore(useShallow((s) => ({ people: s.people, suggestions: s.peopleSuggestions, mergePeople: s.mergePeople })));
  const [other, setOther] = useState<string | null>(null);
  const candidates = [...people, ...suggestions].filter((p) => p.id !== personId);
  if (candidates.length === 0) return null;
  const picked = candidates.find((p) => p.id === other);
  return (
    <Field label="Duplicate">
      <div className="flex flex-wrap items-center gap-1.5">
        <Combobox<string>
          ariaLabel="Duplicate of this person" value={other} size="sm" placeholder="Same person as…" searchPlaceholder="Find a person"
          options={candidates.map((p) => ({ value: p.id, label: p.name, description: p.status === "suggested" ? "Suggested" : p.title, keywords: p.aliases.join(" ") }))}
          onChange={setOther}
        />
        {picked && (
          <ConfirmButton size="sm" variant="outline" confirmLabel={`Merge ${picked.name} into ${name}?`} onConfirm={() => { void mergePeople(personId, picked.id); setOther(null); }}>
            Merge into {name.split(" ")[0]}
          </ConfirmButton>
        )}
      </div>
      <p className="mt-1 text-2xs text-[var(--text-tertiary)]">Their meetings, notes, tasks and teams move here; their name becomes an alias.</p>
    </Field>
  );
}

/**
 * A person capture or an agent proposed (an attendee name, an inferred fact)
 * is not in the list until confirmed. Say so on their page, which chat and
 * notes can open directly, and let the user settle it there.
 */
function SuggestionBanner({ page }: { page: PersonPageModel }) {
  const { confirm, dismiss, people, mergePeople } = useCairnStore(useShallow((s) => ({
    confirm: s.confirmPersonSuggestion, dismiss: s.dismissPersonSuggestion, people: s.people, mergePeople: s.mergePeople,
  })));
  const { person } = page;
  if (person.status !== "suggested" && person.status !== "dismissed") return null;
  const dismissed = person.status === "dismissed";
  return (
    <div role="status" className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--warning)_40%,var(--border-subtle))] bg-[color-mix(in_srgb,var(--warning)_8%,var(--surface-2))] px-3 py-2">
      <p className="min-w-0 flex-1 text-xs text-[var(--text-secondary)]">
        {dismissed
          ? "You dismissed this person, so they stay out of your list and capture won't propose them again."
          : "Suggested from a note or by the assistant. Confirm to add them to your people."}
      </p>
      <Button size="xs" variant="accent" onClick={() => void confirm(person.id)}>{dismissed ? "Add back" : "Confirm"}</Button>
      {!dismissed && people.length > 0 && (
        <Combobox<string>
          ariaLabel="Same person as" value={null} size="sm" align="end" placeholder="Same as…" searchPlaceholder="Find who they are"
          options={people.filter((p) => p.id !== person.id).map((p) => ({ value: p.id, label: p.name, description: p.title, keywords: p.aliases.join(" ") }))}
          // The person you already have stays; this suggestion folds into them.
          onChange={(id) => void mergePeople(id, person.id)}
        />
      )}
      {!dismissed && <Button size="xs" variant="ghost" onClick={() => void dismiss(person.id)}>Dismiss</Button>}
    </div>
  );
}

function PersonPageBody({ page, compact }: { page: PersonPageModel; compact: boolean }) {
  const [editing, setEditing] = useState(false);
  // One read for the header and for the Slack status in Settings.
  const profile = usePersonProfile(page.person);
  return (
    <div className={compact ? "px-4 py-4" : "max-w-[820px] px-8 py-8"}>
      <SuggestionBanner page={page} />
      <PersonHeader page={page} profile={profile} compact={compact} editing={editing} onToggleEdit={() => setEditing((e) => !e)} />
      {editing && <PersonSettings page={page} profile={profile} />}
      <NextMeeting person={page.person} timeline={page.timeline} />
      {/* Slot: Open items, they owe / I owe. */}
      <ConnectionsGraph personId={page.person.id} compact={compact} />
      <Timeline items={page.timeline} />
      <Persona page={page} />
    </div>
  );
}
