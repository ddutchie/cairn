"use client";

/**
 * A team's page, in the People view's side panel: what the team owns, who
 * leads it, where it sits, how to reach it, and who is on it. Membership is
 * each person's `team`, so adding someone here sets their team. A team that
 * only exists as a name on people gets a row the first time you edit it. The
 * assistant reads and writes the same fields through the `people` tool.
 */
import React, { useMemo, useState } from "react";
import { ChevronRight, ExternalLink, Hash, Link2, Pencil, Plus, Sparkles, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { PanelHeading } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { NO_TEAM, flattenTeams, groupByTeam, teamForest, type TeamNode } from "../../../shared/people/teams";
import type { TeamLink } from "../../../shared/types/people";
import { RELATIONSHIP_LABELS } from "./people-model";
import { BlurInput, Field } from "./fields";
import { PersonAvatar } from "./PersonAvatar";

const key = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** The team tree node for `name`, from the store. */
export function useTeamNode(name: string | null): { node: TeamNode | null; all: TeamNode[] } {
  const { people, teams } = useCairnStore(useShallow((s) => ({ people: s.people, teams: s.teams })));
  return useMemo(() => {
    const all = flattenTeams(teamForest(groupByTeam(people, teams)));
    return { node: name ? all.find((n) => key(n.group.team) === key(name)) ?? null : null, all };
  }, [people, teams, name]);
}

function isUrl(s: string): boolean {
  try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; }
}

export function TeamPage({ name, onOpenPerson, onOpenTeam, onGone }: {
  name: string;
  onOpenPerson: (id: string) => void;
  onOpenTeam: (name: string) => void;
  /** The team was deleted or renamed away: the caller closes or follows it. */
  onGone: (renamedTo?: string) => void;
}) {
  const { node, all } = useTeamNode(name);
  const people = useCairnStore((s) => s.people);
  const createTeam = useCairnStore((s) => s.createTeam);
  const [editing, setEditing] = useState(false);

  if (!node) return <EmptyState title="Team not found" description="Nobody is on this team any more." className="py-16" />;
  const { group, path, children } = node;
  const info = group.info;
  const lead = info?.leadPersonId ? people.find((p) => p.id === info.leadPersonId) : undefined;
  const zones = group.timezones.length;
  const meta = [
    `${group.people.length} ${group.people.length === 1 ? "person" : "people"}`,
    zones > 1 ? `${zones} time zones` : null,
    children.length ? `${children.length} ${children.length === 1 ? "team" : "teams"} below` : null,
  ].filter(Boolean).join(" · ");

  const startEditing = async () => {
    // A team that is only a name on people gets its row now, so the details have somewhere to live.
    if (!info) await createTeam({ name: group.team });
    setEditing(true);
  };

  return (
    <div className="@container px-5 py-5">
      <header className="mb-7">
        {path.length > 0 && (
          <nav aria-label="Teams above" className="mb-1.5 flex flex-wrap items-center gap-0.5 text-xs text-[var(--text-tertiary)]">
            {path.map((p, i) => (
              <React.Fragment key={p}>
                {i > 0 && <ChevronRight size={11} aria-hidden />}
                <button type="button" onClick={() => onOpenTeam(p)} className={cn("rounded hover:text-[var(--text-primary)] hover:underline", FOCUS_RING)}>{p}</button>
              </React.Fragment>
            ))}
            <ChevronRight size={11} aria-hidden />
          </nav>
        )}
        <div className="flex items-start gap-3">
          <h1 className="min-w-0 flex-1 font-display text-xl font-normal leading-tight tracking-tight text-balance text-[var(--text-primary)]">{group.team}</h1>
          <Button variant={editing ? "accent" : "outline"} size="sm" onClick={() => (editing ? setEditing(false) : void startEditing())} aria-pressed={editing}>
            <Pencil size={12} /> {editing ? "Done editing" : info ? "Edit team" : "Add details"}
          </Button>
        </div>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">{meta}</p>
        {info?.description ? (
          <p className="mt-3 max-w-[62ch] whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-secondary)]">{info.description}</p>
        ) : !editing && (
          <p className="mt-3 text-xs text-[var(--text-tertiary)]">
            Nothing about what this team owns yet. Add details, or ask the assistant to fill them in from your notes.
          </p>
        )}
        {(lead || info?.channel || (info?.links.length ?? 0) > 0) && (
          <dl className="mt-4 space-y-1.5 text-sm">
            {lead && (
              <div className="flex items-center gap-2">
                <dt className="w-14 text-xs text-[var(--text-tertiary)]">Lead</dt>
                <dd>
                  <button type="button" onClick={() => onOpenPerson(lead.id)} className={cn("inline-flex items-center gap-1.5 rounded text-[var(--text-primary)] hover:underline", FOCUS_RING)}>
                    <PersonAvatar name={lead.name} isMe={lead.isMe} size="xs" />{lead.name}
                  </button>
                </dd>
              </div>
            )}
            {info?.channel && (
              <div className="flex items-center gap-2">
                <dt className="w-14 text-xs text-[var(--text-tertiary)]">Channel</dt>
                <dd className="inline-flex items-center gap-1 text-[var(--text-secondary)]"><Hash size={11} aria-hidden />{info.channel.replace(/^#/, "")}</dd>
              </div>
            )}
            {info && info.links.length > 0 && (
              <div className="flex items-start gap-2">
                <dt className="w-14 pt-0.5 text-xs text-[var(--text-tertiary)]">Links</dt>
                <dd className="flex flex-wrap gap-x-3 gap-y-1">
                  {info.links.map((l) => (
                    <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className={cn("inline-flex items-center gap-1 rounded text-[var(--accent)] hover:underline", FOCUS_RING)}>
                      <Link2 size={11} aria-hidden />{l.label}
                    </a>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        )}
      </header>

      {editing && info && <TeamSettings key={info.id} node={node} all={all} onGone={onGone} />}

      {children.length > 0 && (
        <section className="mb-9" aria-label="Teams below">
          <PanelHeading title="Teams below" note={String(children.length)} />
          <ul className="space-y-1">
            {children.map((c) => (
              <li key={c.group.team}>
                <button type="button" onClick={() => onOpenTeam(c.group.team)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", FOCUS_RING)}>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">{c.group.team}</span>
                  <span className="text-2xs tabular-nums text-[var(--text-tertiary)]">{c.group.people.length}</span>
                  <ChevronRight size={12} className="text-[var(--text-tertiary)]" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Members node={node} editing={editing} onOpenPerson={onOpenPerson} />

      {!editing && (
        <p className="mt-6 flex items-start gap-1.5 text-2xs text-[var(--text-tertiary)]">
          <Sparkles size={11} className="mt-px flex-shrink-0" aria-hidden />
          The assistant can read and update this team: ask it who is on {group.team}, or to fill in what the team owns.
        </p>
      )}
    </div>
  );
}

function Members({ node, editing, onOpenPerson }: { node: TeamNode; editing: boolean; onOpenPerson: (id: string) => void }) {
  const { people, updatePerson } = useCairnStore(useShallow((s) => ({ people: s.people, updatePerson: s.updatePerson })));
  const { group } = node;
  const leadId = group.info?.leadPersonId;
  const members = [...group.people].sort((a, b) => Number(b.id === leadId) - Number(a.id === leadId));
  const others = people.filter((p) => key(p.team ?? "") !== key(group.team));
  return (
    <section aria-label="Members">
      <PanelHeading
        title="Members"
        note={String(group.people.length)}
        action={editing ? (
          <Combobox<string>
            ariaLabel="Add a member"
            value={null}
            size="sm"
            align="end"
            placeholder="Add member"
            searchPlaceholder="Find a person"
            emptyText="Everyone is on this team"
            options={others.map((p) => ({ value: p.id, label: p.name, description: p.team ? `On ${p.team}` : undefined, keywords: p.title }))}
            onChange={(id) => void updatePerson(id, { team: group.team })}
            renderTrigger={() => <span className="inline-flex items-center gap-1 text-xs"><Plus size={12} /> Add member</span>}
          />
        ) : undefined}
      />
      {members.length === 0 ? (
        <p className="text-xs text-[var(--text-tertiary)]">Nobody is on this team yet.</p>
      ) : (
        <ul className="space-y-0.5">
          {members.map((p) => {
            const rel = p.relationship[0];
            const sub = [p.title, rel ? (rel.label || RELATIONSHIP_LABELS[rel.type]) : null].filter(Boolean).join(" · ");
            return (
              <li key={p.id} className="flex items-center gap-1">
                <button type="button" onClick={() => onOpenPerson(p.id)} className={cn("flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", FOCUS_RING)}>
                  <PersonAvatar name={p.name} isMe={p.isMe} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--text-primary)]">
                      {p.name}{p.isMe ? " (you)" : ""}
                      {p.id === leadId && <span className="ml-1.5 text-2xs text-[var(--text-tertiary)]">Lead</span>}
                    </span>
                    {sub && <span className="block truncate text-2xs text-[var(--text-tertiary)]">{sub}</span>}
                  </span>
                </button>
                {editing && (
                  <IconButton label={`Take ${p.name} off ${group.team}`} size="sm" onClick={() => void updatePerson(p.id, { team: null })}><X size={12} /></IconButton>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TeamSettings({ node, all, onGone }: { node: TeamNode; all: TeamNode[]; onGone: (renamedTo?: string) => void }) {
  const { people, updateTeam, createTeam, deleteTeam } = useCairnStore(useShallow((s) => ({
    people: s.people, updateTeam: s.updateTeam, createTeam: s.createTeam, deleteTeam: s.deleteTeam,
  })));
  const info = node.group.info!;
  const [error, setError] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");

  // A team can't sit under itself or anything below it.
  const below = new Set(flattenTeams([node]).map((n) => key(n.group.team)));
  const parents = all.filter((n) => !below.has(key(n.group.team)) && n.group.team !== NO_TEAM);
  const parentName = info.parentTeamId ? all.find((n) => n.group.info?.id === info.parentTeamId)?.group.team : undefined;

  const save = async (patch: Parameters<typeof updateTeam>[1]) => {
    setError(null);
    const out = await updateTeam(info.id, patch);
    if (!out) setError("Couldn't save that. A team with that name may already exist.");
    return out;
  };
  const setParent = async (name: string) => {
    if (name === "") return void save({ parentTeamId: null });
    const target = all.find((n) => key(n.group.team) === key(name));
    const id = target?.group.info?.id ?? (await createTeam({ name }))?.id;
    if (id) await save({ parentTeamId: id });
  };
  const addLink = () => {
    const url = linkUrl.trim();
    if (!isUrl(url)) { setError("Links need a full address, starting with https://"); return; }
    void save({ links: [...info.links, { label: linkLabel.trim(), url }] });
    setLinkUrl(""); setLinkLabel("");
  };

  return (
    <section className="@container mb-9" aria-label="Team details">
      <PanelHeading title="Details" note="Saved as you change them" />
      {error && <p role="alert" className="mb-2 text-2xs text-[var(--danger)]">{error}</p>}
      <Field label="Name">
        <BlurInput ariaLabel="Team name" value={info.name} onSave={async (v) => {
          if (!v.trim()) return;
          const out = await save({ name: v });
          if (out && key(out.name) !== key(node.group.team)) onGone(out.name);
        }} />
      </Field>
      <Field label="What it owns">
        <textarea
          key={info.description ?? ""}
          defaultValue={info.description ?? ""}
          aria-label="What the team owns"
          rows={4}
          placeholder="e.g. Sync engine, mobile replication, the conflict copy rules"
          onBlur={(e) => { if (e.target.value !== (info.description ?? "")) void save({ description: e.target.value || null }); }}
          className={cn("w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]", FOCUS_RING)}
        />
      </Field>
      <Field label="Lead">
        <Combobox<string>
          ariaLabel="Team lead"
          value={info.leadPersonId ?? null}
          placeholder="Choose a lead"
          searchPlaceholder="Find a person"
          className="w-full"
          options={[
            ...(info.leadPersonId ? [{ value: "", label: "No lead" }] : []),
            ...[...people]
              .sort((a, b) => Number(key(b.team ?? "") === key(node.group.team)) - Number(key(a.team ?? "") === key(node.group.team)))
              .map((p) => ({ value: p.id, label: p.name, group: key(p.team ?? "") === key(node.group.team) ? "On this team" : "Everyone else", keywords: p.title })),
          ]}
          onChange={(id) => void save({ leadPersonId: id || null })}
        />
      </Field>
      <Field label="Sits under">
        <Select<string>
          ariaLabel="Team it sits under"
          value={parentName ?? ""}
          className="w-full"
          options={[{ value: "", label: "Nothing (a top-level team)" }, ...parents.map((n) => ({ value: n.group.team, label: [...n.path, n.group.team].join(" › ") }))]}
          onChange={(v) => void setParent(v)}
        />
      </Field>
      <Field label="Channel">
        <BlurInput ariaLabel="Channel" placeholder="e.g. #sync" value={info.channel ?? ""} onSave={(v) => void save({ channel: v.trim() || null })} />
      </Field>
      <Field label="Links">
        {info.links.length > 0 && (
          <ul className="mb-1.5 space-y-1">
            {info.links.map((l: TeamLink) => (
              <li key={l.url} className="flex items-center gap-1.5 text-xs">
                <ExternalLink size={11} className="text-[var(--text-tertiary)]" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]" title={l.url}>{l.label}</span>
                <IconButton label={`Remove ${l.label}`} size="sm" onClick={() => void save({ links: info.links.filter((x) => x.url !== l.url) })}><X size={12} /></IconButton>
              </li>
            ))}
          </ul>
        )}
        <form className="flex flex-wrap gap-1.5" onSubmit={(e) => { e.preventDefault(); addLink(); }}>
          <Input aria-label="Link address" placeholder="https://…" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} className="min-w-0 flex-[2] text-xs" />
          <Input aria-label="Link name" placeholder="Name (optional)" value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} className="min-w-0 flex-1 text-xs" />
          <Button type="submit" size="xs" variant="outline" disabled={!linkUrl.trim()}>Add</Button>
        </form>
      </Field>
      <div className="mt-4 flex justify-end">
        <ConfirmButton
          variant="ghost" size="xs" confirmLabel={`Delete ${info.name}? Its members leave it`}
          onConfirm={async () => { await deleteTeam(info.id); onGone(); }}
        >
          Delete team
        </ConfirmButton>
      </div>
    </section>
  );
}
