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

import React, { useRef, useState } from "react";
import { CalendarDays, CheckCircle2, FileText, Kanban, Lock, Pencil, X, AtSign } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Toggle } from "@/components/ui/toggle";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { PanelHeading } from "@/components/ui/panel";
import { MicroLabel } from "@/components/ui/labels";
import { EmptyState } from "@/components/ui/empty-state";
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";
import { revealCard, revealNote } from "@/lib/events";
import { formatDate, formatRelative } from "../../../shared/format/date";
import { cn } from "@/lib/utils";
import { CADENCES, RELATIONSHIP_TYPES, type Cadence, type RelationshipType } from "../../../shared/types/people";
import type { PersonPage as PersonPageModel, PersonTimelineItem } from "../../../shared/types/people-view";
import {
  CADENCE_LABELS, EDGE_ROLE_OPTIONS, RELATIONSHIP_LABELS, describeRelation, splitList,
} from "./people-model";
import { NextMeeting, ProfileLine, usePersonProfile } from "./PersonOneOnOne";

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

function PersonHeader({ page, editing, onToggleEdit }: { page: PersonPageModel; editing: boolean; onToggleEdit: () => void }) {
  const { person, relations } = page;
  const profile = usePersonProfile(person);
  const facts = [
    person.cadence ? `${CADENCE_LABELS[person.cadence]} 1:1s` : null,
    page.lastMetAt ? `Last met ${formatRelative(page.lastMetAt, { absoluteAfterDays: 30 })}` : "No meetings yet",
  ].filter(Boolean);
  return (
    <header className="mb-8">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-3xl font-normal leading-[1.08] tracking-tight text-balance text-[var(--text-primary)] flex items-center gap-2">
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
          <Pencil size={12} /> {editing ? "Done" : "Edit"}
        </Button>
      </div>
      <ProfileLine profile={profile} />
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {person.relationship.map((r) => (
          <Chip key={`${r.type}|${r.label ?? ""}`}>
            {r.label ? `${RELATIONSHIP_LABELS[r.type]}, ${r.label}` : RELATIONSHIP_LABELS[r.type]}
          </Chip>
        ))}
        {person.stage && <Chip>Stage: {person.stage}</Chip>}
        <span className="text-xs text-[var(--text-tertiary)] ml-1">{facts.join(". ")}</span>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-start gap-3 py-2 border-b border-[var(--border-subtle)] last:border-0">
      <MicroLabel className="pt-1.5 text-xs">{label}</MicroLabel>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * A text input that saves on blur or Enter. Callers key it by the saved value
 * (see BlurInput below), so a save or an outside change starts a fresh draft.
 */
function DraftInput({ value, onSave, placeholder, ariaLabel }: {
  value: string; onSave: (v: string) => void; placeholder?: string; ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <Input
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className="text-xs"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onSave(draft); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

function BlurInput(props: React.ComponentProps<typeof DraftInput>) {
  return <DraftInput key={props.value} {...props} />;
}

function PersonSettings({ page }: { page: PersonPageModel }) {
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
  const toggleRelationship = (t: RelationshipType) => {
    const base = pendingRel.current?.list ?? person.relationship;
    const next = base.some((r) => r.type === t)
      ? base.filter((r) => r.type !== t)
      : [...base, { type: t, provenance: "explicit" as const }];
    const pending = pendingRel.current ?? { list: next, writes: 0 };
    pending.list = next;
    pending.writes += 1;
    pendingRel.current = pending;
    void updatePerson(person.id, { relationship: next }).finally(() => {
      if (pendingRel.current && --pendingRel.current.writes === 0) pendingRel.current = null;
    });
  };

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
    <section className="mb-9" aria-label="Person settings">
      <PanelHeading title="Settings" note="Saved as you change them" />
      <Field label="Name">
        <BlurInput ariaLabel="Name" value={person.name} onSave={(v) => { if (v.trim()) void updatePerson(person.id, { name: v }); }} />
      </Field>
      <Field label="Relationship">
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
      <Field label="Relationships">
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

function Persona({ page }: { page: PersonPageModel }) {
  const reveal = useReveal();
  const updateNote = useCairnStore((s) => s.updateNote);
  const { persona } = page;
  const [draft, setDraft] = useState<string | null>(null);
  // Our own save, shown until the page model catches up (it is read from the
  // database, which the note write reaches a moment later).
  const [saved, setSaved] = useState<{ base: string; content: string } | null>(null);
  const content = persona ? (saved && saved.base === persona.content ? saved.content : persona.content) : "";

  const save = () => {
    if (!persona || draft === null) return;
    if (draft !== content) {
      updateNote(persona.id, { content: draft });
      setSaved({ base: persona.content, content: draft });
    }
    setDraft(null);
  };

  return (
    <section className="mb-9" aria-label="Persona">
      <PanelHeading
        title="Persona"
        note={persona ? persona.title : undefined}
        action={persona ? (
          <div className="flex items-center gap-1">
            {draft === null ? (
              <Button variant="ghost" size="xs" onClick={() => setDraft(content)}>
                <Pencil size={11} /> Edit
              </Button>
            ) : (
              <Button variant="accent" size="xs" onClick={save}>Done</Button>
            )}
            <Button variant="ghost" size="xs" onClick={() => reveal.note(persona.projectId, persona.id)}>
              <FileText size={11} /> Open in Notes
            </Button>
          </div>
        ) : undefined}
      />
      {persona ? (
        draft !== null ? (
          <textarea
            aria-label="Persona note"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            rows={12}
            className={cn(
              "w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-primary)]",
              "placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]",
            )}
            placeholder="What they care about, how they like to work, how to help them grow"
          />
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
  const [editing, setEditing] = useState(false);

  if (!page) {
    return <EmptyState title="Loading" className="py-16" />;
  }
  return (
    <div className={compact ? "px-4 py-4" : "max-w-[820px] px-8 py-8"}>
      <PersonHeader page={page} editing={editing} onToggleEdit={() => setEditing((e) => !e)} />
      {editing && <PersonSettings page={page} />}
      <NextMeeting person={page.person} timeline={page.timeline} />
      {/* Slot: Open items, they owe / I owe. */}
      <Timeline items={page.timeline} />
      <Persona page={page} />
    </div>
  );
}
