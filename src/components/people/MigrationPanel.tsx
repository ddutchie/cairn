"use client";

/**
 * "Find people in your notes" (People layer, W9 migration gate): scans the
 * workspace for person and meeting notes it already has, lets the user tick
 * what to bring into the People layer, previews it, and only then applies it.
 * Nothing is written by looking, and nothing the user doesn't tick is touched;
 * notes keep their text (meeting notes get `attendees`/`date` properties).
 * Plan: docs/plans/people-layer.md ("Migrating existing person notes").
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useCairnStore } from "@/store";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SectionLabel } from "@/components/ui/labels";
import { BatchAutofill } from "./BatchAutofill";
import { peopleClient } from "@/lib/ipc/people";
import { reportIpcError } from "@/lib/ipc/client";
import type { MigrationInventory, MigrationResult, PersonaCandidate } from "../../../shared/types/people-migration";

const SKIP_TEXT: Record<string, string> = {
  already_linked: "Already a person",
  archived: "Archived",
  ambiguous_name: "Another note has the same name: rename one first",
  person_has_persona: "That person already has a persona note",
  dismissed: "You dismissed this person",
  identity_conflict: "Name and email match different people",
  removed_by_user: "You removed this person",
};

function Check({ id, checked, onChange, label, disabled }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; disabled?: boolean }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
      <input id={id} type="checkbox" className="accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 flex-1">{label}</span>
    </label>
  );
}

export function summarise(r: MigrationResult): string[] {
  const count = (o: string) => r.personas.filter((p) => p.outcome === o).length;
  const lines: string[] = [];
  if (count("created")) lines.push(`${count("created")} new ${count("created") === 1 ? "person" : "people"}`);
  if (count("linked")) lines.push(`${count("linked")} existing ${count("linked") === 1 ? "person" : "people"} linked to their note`);
  if (count("unchanged")) lines.push(`${count("unchanged")} already done`);
  if (count("skipped")) lines.push(`${count("skipped")} skipped`);
  const meetings = r.meetings.filter((m) => m.outcome === "captured").length;
  if (meetings) lines.push(`${meetings} ${meetings === 1 ? "meeting" : "meetings"} with attendees`);
  const unmatched = new Set(r.meetings.flatMap((m) => m.unmatched));
  if (unmatched.size) lines.push(`${unmatched.size} listed ${unmatched.size === 1 ? "name matches nobody and stays" : "names match nobody and stay"} as text`);
  const mentions = r.index.mentionsAfter - r.index.mentionsBefore;
  if (mentions > 0) lines.push(`${mentions} ${mentions === 1 ? "link" : "links"} to people`);
  const items = r.index.ownedItemsAfter - r.index.ownedItemsBefore;
  if (items > 0) lines.push(`${items} action ${items === 1 ? "item" : "items"} assigned`);
  return lines.length ? lines : ["Nothing to change"];
}

export function MigrationPanel({ onClose }: { onClose: () => void }) {
  const workspaceId = useCairnStore((s) => s.activeWorkspaceId);
  const refreshPeople = useCairnStore((s) => s.refreshPeople);
  const [inventory, setInventory] = useState<MigrationInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [people, setPeople] = useState<Set<string>>(new Set());
  const [aliases, setAliases] = useState<Set<string>>(new Set());
  const [meetings, setMeetings] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ result: MigrationResult; applied: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    peopleClient.migrationInventory(workspaceId).then((inv) => {
      if (!live) return;
      setInventory(inv);
      // Ticked from the start: the confident ones that can be done. Weak guesses and the rest are the user's call.
      setPeople(new Set(inv.personas.filter((p) => p.action !== "skip" && p.confidence !== "low").map((p) => p.noteId)));
      setMeetings(new Set(inv.meetings.filter((m) => m.attendees.some((a) => a.resolution === "person" || a.resolution === "candidate")).map((m) => m.noteId)));
    }).catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, [workspaceId]);

  const approvals = useMemo(() => ({
    personas: [...people].map((noteId) => ({
      noteId,
      aliases: [...aliases].filter((k) => k.startsWith(`${noteId}|`)).map((k) => k.slice(noteId.length + 1)),
    })),
    meetings: [...meetings],
  }), [people, aliases, meetings]);

  const run = useCallback(async (dryRun: boolean) => {
    if (!workspaceId || busy) return;
    setBusy(true);
    try {
      const r = await peopleClient.migrationApply(workspaceId, approvals, dryRun);
      setResult({ result: r, applied: !dryRun && r.applied });
      if (!dryRun) await refreshPeople();
    } catch (err) {
      reportIpcError(err, "People migration");
    } finally {
      setBusy(false);
    }
  }, [workspaceId, busy, approvals, refreshPeople]);

  // Once applied the ticks are history; changing one would clear the result (and the fill-details review under it).
  const locked = busy || result?.applied === true;
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string, on: boolean) => {
    if (result?.applied) return;
    const next = new Set(set);
    if (on) next.add(key); else next.delete(key);
    setter(next);
    setResult(null);
  };

  const row = (c: PersonaCandidate) => {
    const skipped = c.action === "skip";
    return (
      <li key={c.noteId} className="py-1.5">
        <Check
          id={`mig-p-${c.noteId}`}
          checked={people.has(c.noteId)}
          disabled={skipped || locked}
          onChange={(v) => toggle(people, setPeople, c.noteId, v)}
          label={
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate">{c.name}</span>
              <Badge size="xs" title={c.reasons.join(", ")}>{c.confidence}</Badge>
              {c.action === "link_existing" && <span className="text-2xs text-[var(--text-tertiary)]">links to {c.existingPerson?.name}</span>}
              {skipped && c.skipReason && <span className="text-2xs text-[var(--text-tertiary)]">{SKIP_TEXT[c.skipReason] ?? c.skipReason}</span>}
            </span>
          }
        />
        {!skipped && c.suggestedAliases.map((a) => (
          <div key={a} className="ml-6 mt-0.5">
            <Check id={`mig-a-${c.noteId}-${a}`} disabled={locked} checked={aliases.has(`${c.noteId}|${a}`)} onChange={(v) => toggle(aliases, setAliases, `${c.noteId}|${a}`, v)}
              label={<span className="text-xs text-[var(--text-secondary)]">Also answer to “{a}” (so “{a}” in notes finds them)</span>} />
          </div>
        ))}
      </li>
    );
  };

  const personaRows = inventory?.personas ?? [];
  return (
    <ModalShell
      onClose={onClose}
      size="lg"
      scrollable
      title="Find people in your notes"
      subtitle="Nothing changes until you apply. Your notes keep their text; meeting notes get attendees and date properties."
      description="Review the person and meeting notes Cairn found, preview, then apply."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{result?.applied ? "Done" : "Cancel"}</Button>
          <Button variant="outline" size="sm" disabled={busy || !inventory || result?.applied} onClick={() => void run(true)}>Preview</Button>
          <Button size="sm" disabled={busy || !inventory || result?.applied || (people.size === 0 && meetings.size === 0)} onClick={() => void run(false)}>
            Apply {people.size + meetings.size > 0 ? `(${people.size + meetings.size})` : ""}
          </Button>
        </>
      }
    >
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      {!inventory && !error && <p className="text-sm text-[var(--text-tertiary)]">Scanning notes…</p>}
      {inventory && (
        <div className="space-y-4">
          <section aria-label="People found">
            <SectionLabel>People ({personaRows.length})</SectionLabel>
            {personaRows.length === 0
              ? <p className="mt-1 text-sm text-[var(--text-tertiary)]">No person notes found. Tag them “person” or keep them in a People folder.</p>
              : <ul className="mt-1 divide-y divide-[var(--border-subtle)]">{personaRows.map(row)}</ul>}
            {inventory.ambiguousShortNames.length > 0 && (
              <p className="mt-2 text-xs text-[var(--text-tertiary)]">
                {inventory.ambiguousShortNames.map((a) => `“${a.text}”`).join(", ")} fits more than one person, so items and attendees written that way stay unassigned.
              </p>
            )}
          </section>
          <section aria-label="Meeting notes found">
            <SectionLabel>Meeting notes ({inventory.meetings.length})</SectionLabel>
            {inventory.meetings.length === 0
              ? <p className="mt-1 text-sm text-[var(--text-tertiary)]">No meeting notes with an Attendees line or property.</p>
              : (
                <ul className="mt-1 divide-y divide-[var(--border-subtle)]">
                  {inventory.meetings.map((m) => {
                    const known = m.attendees.filter((a) => a.resolution === "person" || a.resolution === "candidate").length;
                    return (
                      <li key={m.noteId} className="py-1.5">
                        <Check id={`mig-m-${m.noteId}`} disabled={locked} checked={meetings.has(m.noteId)} onChange={(v) => toggle(meetings, setMeetings, m.noteId, v)}
                          label={<span className="flex items-center gap-1.5"><span className="truncate">{m.title}</span>
                            <span className="text-2xs text-[var(--text-tertiary)]">{known} of {m.attendees.length} known</span></span>} />
                      </li>
                    );
                  })}
                </ul>
              )}
          </section>
          {result && (
            <section aria-label={result.applied ? "Applied" : "Preview"} className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] p-2.5">
              <SectionLabel>{result.applied ? "Done" : "Preview: nothing has changed yet"}</SectionLabel>
              <ul className="mt-1 list-disc pl-4 text-sm">{summarise(result.result).map((l) => <li key={l}>{l}</li>)}</ul>
            </section>
          )}
          {result?.applied && (
            <BatchAutofill
              people={result.result.personas.flatMap((r) => {
                if (!r.personId || (r.outcome !== "created" && r.outcome !== "linked")) return [];
                const name = personaRows.find((c) => c.noteId === r.noteId)?.name;
                return name ? [{ personId: r.personId, name }] : [];
              })}
            />
          )}
        </div>
      )}
    </ModalShell>
  );
}
