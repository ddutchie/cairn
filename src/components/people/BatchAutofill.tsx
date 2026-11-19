"use client";

/**
 * After a migration applies: fill role, team, location and time zone for the
 * people it brought in, from their persona notes. One AI call per person, run
 * one at a time and cancellable; the results come back as one list to review
 * (empty fields ticked, replacements not) and nothing is written until Apply.
 */

import React, { useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { useCairnStore } from "@/store";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/labels";
import { peopleClient } from "@/lib/ipc/people";
import { reportIpcError } from "@/lib/ipc/client";
import type { AutofillProposal } from "../../../shared/people/autofill";
import type { ProfileField } from "../../../shared/people/parse";

export const FIELD_LABEL: Record<ProfileField, string> = { title: "Role", team: "Team", location: "Location", timezone: "Time zone" };
const SKIP_TEXT: Record<string, string> = {
  off: "People is off",
  "no-ai": "no AI connection",
  private: "private to you",
  "no-persona": "no persona note",
  empty: "empty note",
  failed: "couldn't read the note",
};

interface Group { personId: string; name: string; proposals: AutofillProposal[] }
type State =
  | { kind: "idle" }
  | { kind: "running"; done: number }
  | { kind: "review"; groups: Group[]; skipped: { name: string; reason: string }[]; cancelled: boolean }
  | { kind: "applied"; count: number };

const key = (personId: string, field: ProfileField) => `${personId}|${field}`;

export function BatchAutofill({ people }: { people: { personId: string; name: string }[] }) {
  const refreshPeople = useCairnStore((s) => s.refreshPeople);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const stop = useRef(false);

  if (people.length === 0) return null;

  const run = async () => {
    stop.current = false;
    const groups: Group[] = [];
    const skipped: { name: string; reason: string }[] = [];
    let cancelled = false;
    for (let i = 0; i < people.length; i++) {
      if (stop.current) { cancelled = true; break; }
      setState({ kind: "running", done: i });
      const p = people[i];
      try {
        const res = await peopleClient.autofill(p.personId);
        if ("skipped" in res) skipped.push({ name: p.name, reason: SKIP_TEXT[res.skipped] ?? res.skipped });
        else if (res.proposals.length) groups.push({ personId: p.personId, name: p.name, proposals: res.proposals });
      } catch {
        skipped.push({ name: p.name, reason: SKIP_TEXT.failed });
      }
    }
    // Empty fields start ticked; replacing a value is the user's choice.
    setPicked(new Set(groups.flatMap((g) => g.proposals.filter((x) => !x.current).map((x) => key(g.personId, x.field)))));
    setState({ kind: "review", groups, skipped, cancelled });
  };

  const apply = async () => {
    if (state.kind !== "review" || busy) return;
    setBusy(true);
    let count = 0;
    try {
      for (const g of state.groups) {
        const patch: Record<string, string> = {};
        for (const x of g.proposals) if (picked.has(key(g.personId, x.field))) patch[x.field] = x.value;
        if (Object.keys(patch).length === 0) continue;
        await peopleClient.update(g.personId, patch);
        count++;
      }
      await refreshPeople();
      setState({ kind: "applied", count });
    } catch (err) {
      reportIpcError(err, "Couldn't save the details");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (k: string, on: boolean) => setPicked((prev) => { const n = new Set(prev); if (on) n.add(k); else n.delete(k); return n; });

  return (
    <section aria-label="Fill details" className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] p-2.5">
      <SectionLabel>Fill details from persona notes</SectionLabel>
      {state.kind === "idle" && (
        <>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Read each persona note for role, team, location and time zone. {people.length} {people.length === 1 ? "person" : "people"}, one AI call each. You review before anything is saved.
          </p>
          <Button className="mt-2" variant="outline" size="xs" onClick={() => void run()}><Sparkles size={11} /> Fill details</Button>
        </>
      )}
      {state.kind === "running" && (
        <div className="mt-1 flex items-center gap-3 text-sm">
          <span role="status">Reading note {Math.min(state.done + 1, people.length)} of {people.length}…</span>
          <Button variant="ghost" size="xs" onClick={() => { stop.current = true; }}>Stop</Button>
        </div>
      )}
      {state.kind === "review" && (
        <div className="mt-1">
          {state.cancelled && <p className="text-xs text-[var(--text-tertiary)]">Stopped early. The remaining notes were not read.</p>}
          {state.groups.length === 0
            ? <p className="text-sm text-[var(--text-secondary)]">The notes say nothing new about these fields.</p>
            : (
              <ul className="space-y-2">
                {state.groups.map((g) => (
                  <li key={g.personId}>
                    <div className="text-sm font-medium text-[var(--text-primary)]">{g.name}</div>
                    <ul className="ml-1 mt-0.5 space-y-1">
                      {g.proposals.map((x) => (
                        <li key={x.field}>
                          <label className="flex items-start gap-2 text-sm">
                            <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={picked.has(key(g.personId, x.field))} onChange={(e) => toggle(key(g.personId, x.field), e.target.checked)} />
                            <span className="min-w-0">
                              <span className="text-[var(--text-tertiary)]">{FIELD_LABEL[x.field]}: </span>{x.value}
                              {x.current && <span className="text-xs text-[var(--text-tertiary)]"> (now {x.current})</span>}
                              <span className="block truncate text-xs text-[var(--text-tertiary)]" title={x.quote}>“{x.quote}”</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          {state.skipped.length > 0 && (
            <p className="mt-2 text-xs text-[var(--text-tertiary)]">Skipped: {state.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}.</p>
          )}
          <div className="mt-3 flex gap-2">
            {state.groups.length > 0 && <Button variant="accent" size="xs" disabled={picked.size === 0 || busy} onClick={() => void apply()}>Apply</Button>}
            <Button variant="ghost" size="xs" onClick={() => setState({ kind: "idle" })}>{state.groups.length > 0 ? "Cancel" : "Close"}</Button>
          </div>
        </div>
      )}
      {state.kind === "applied" && <p role="status" className="mt-1 text-sm">Saved details for {state.count} {state.count === 1 ? "person" : "people"}.</p>}
    </section>
  );
}
