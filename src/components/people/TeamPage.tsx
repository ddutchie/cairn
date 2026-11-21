"use client";

/**
 * A team's page, in the People view's side panel: what the team owns, who
 * leads it, where it sits, how to reach it, who is on it (with their role)
 * and who used to be. Membership is a `team_memberships` row per person, so
 * adding someone here never takes them off another team, and taking them off
 * keeps the stint as history. A team that two devices named alike can be
 * merged into this one. The assistant reads and writes the same fields
 * through the `people` tool.
 */
import React, { useMemo, useRef, useState } from "react";
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
import { NO_TEAM_KEY, flattenTeams, groupByTeam, teamForest, type TeamNode } from "../../../shared/people/teams";
import { TEAM_KINDS, type TeamKind, type TeamLink } from "../../../shared/types/people";
import { formatDate } from "../../../shared/format/date";
import { usePeopleNetwork } from "@/components/graph/peopleCanvasShared";
import { deriveLinks } from "@/lib/people/network";
import { RELATIONSHIP_LABELS } from "./people-model";
import { BlurInput, Field } from "./fields";
import { PersonAvatar } from "./PersonAvatar";

const key = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

export const KIND_LABEL: Record<TeamKind, string> = { team: "Team", guild: "Guild", project: "Project", committee: "Committee" };

/** The team tree node for a group key (a team id), or failing that a team name, from the store. */
export function useTeamNode(ref: string | null): { node: TeamNode | null; all: TeamNode[] } {
  const { people, teams } = useCairnStore(useShallow((s) => ({ people: s.people, teams: s.teams })));
  return useMemo(() => {
    const all = flattenTeams(teamForest(groupByTeam(people, teams)));
    const node = ref ? all.find((n) => n.group.key === ref) ?? all.find((n) => key(n.group.team) === key(ref)) ?? null : null;
    return { node, all };
  }, [people, teams, ref]);
}

function isUrl(s: string): boolean {
  try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; }
}

export function TeamPage({ name, onOpenPerson, onOpenTeam, onGone }: {
  /** The team's group key (its id), or a team name. */
  name: string;
  onOpenPerson: (id: string) => void;
  onOpenTeam: (key: string) => void;
  /** The team was deleted or merged away: the caller closes it, or follows `into`. */
  onGone: (into?: string) => void;
}) {
  const { node, all } = useTeamNode(name);
  const { people, createTeam, mergeTeams } = useCairnStore(useShallow((s) => ({ people: s.people, createTeam: s.createTeam, mergeTeams: s.mergeTeams })));
  const [editing, setEditing] = useState(false);

  if (!node) return <EmptyState title="Team not found" description="Nobody is on this team any more." className="py-16" />;
  const { group, children } = node;
  const info = group.info;
  const lead = info?.leadPersonId ? people.find((p) => p.id === info.leadPersonId) : undefined;
  const zones = group.timezones.length;
  const twins = info ? all.filter((n) => n.group.info && n.group.key !== group.key && key(n.group.team) === key(group.team)) : [];
  // The teams above this one, by their ids, so two teams with one name each open the right parent.
  const ancestors: TeamNode[] = [];
  for (let pid = info?.parentTeamId; pid;) {
    const up = all.find((n) => n.group.key === pid);
    if (!up || ancestors.includes(up)) break;
    ancestors.unshift(up);
    pid = up.group.info?.parentTeamId;
  }
  const meta = [
    info && info.kind !== "team" ? KIND_LABEL[info.kind] : null,
    `${group.people.length} ${group.people.length === 1 ? "person" : "people"}`,
    zones > 1 ? `${zones} time zones` : null,
    children.length ? `${children.length} ${children.length === 1 ? "team" : "teams"} below` : null,
  ].filter(Boolean).join(" · ");

  const startEditing = async () => {
    // A team that is only a name on people gets its row now, so the details have somewhere to live.
    if (!info) {
      const made = await createTeam({ name: group.team });
      if (!made) return;
      // The group is now keyed by the new team's id, so the panel follows it.
      onOpenTeam(made.id);
    }
    setEditing(true);
  };

  return (
    <div className="@container px-5 py-5">
      <header className="mb-7">
        {ancestors.length > 0 && (
          <nav aria-label="Teams above" className="mb-1.5 flex flex-wrap items-center gap-0.5 text-xs text-[var(--text-tertiary)]">
            {ancestors.map((a, i) => (
              <React.Fragment key={a.group.key}>
                {i > 0 && <ChevronRight size={11} aria-hidden />}
                <button type="button" onClick={() => onOpenTeam(a.group.key)} className={cn("rounded hover:text-[var(--text-primary)] hover:underline", FOCUS_RING)}>{a.group.team}</button>
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
        {twins.length > 0 && (
          <div role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-secondary)]">
            <span className="min-w-0 flex-1">
              Another team is also called {group.team}, with {twins[0].group.people.length} {twins[0].group.people.length === 1 ? "person" : "people"}. Two devices probably made it before they synced.
            </span>
            <Button size="xs" variant="outline" onClick={() => void mergeTeams(info!.id, twins[0].group.info!.id)}>Merge into this one</Button>
          </div>
        )}
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
              <div className="flex items-start gap-2">
                <dt className="w-14 pt-0.5 text-xs text-[var(--text-tertiary)]">Lead</dt>
                <dd>
                  <button type="button" onClick={() => onOpenPerson(lead.id)} className={cn("inline-flex items-center gap-1.5 rounded text-[var(--text-primary)] hover:underline", FOCUS_RING)}>
                    <PersonAvatar name={lead.name} isMe={lead.isMe} size="xs" />{lead.name}
                  </button>
                  <LeadHint leadId={lead.id} leadName={lead.name} node={node} />
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
              <li key={c.group.key}>
                <button type="button" onClick={() => onOpenTeam(c.group.key)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--surface-2)]", FOCUS_RING)}>
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
      <PastMembers node={node} onOpenPerson={onOpenPerson} />

      {!editing && (
        <p className="mt-6 flex items-start gap-1.5 text-2xs text-[var(--text-tertiary)]">
          <Sparkles size={11} className="mt-px flex-shrink-0" aria-hidden />
          The assistant can read and update this team: ask it who is on {group.team}, or to fill in what the team owns.
        </p>
      )}
    </div>
  );
}

/**
 * Where the lead and the reporting line disagree, said quietly: a lead who
 * isn't on the team, or one nobody on it reports to. Both can be right (a
 * tech lead manages nobody); it's a prompt, not an error.
 */
function LeadHint({ leadId, leadName, node }: { leadId: string; leadName: string; node: TeamNode }) {
  const { people, network } = usePeopleNetwork();
  const others = node.group.people.filter((p) => p.id !== leadId);
  const onTeam = node.group.people.some((p) => p.id === leadId);
  const reports = useMemo(() => {
    const ids = new Set(others.map((p) => p.id));
    return deriveLinks(people, network.edges, []).filter((l) => l.kind === "reporting" && !l.ended && l.source === leadId && ids.has(l.target)).length;
  }, [people, network, others, leadId]);
  const first = leadName.split(" ")[0];
  const text = !onTeam ? `${first} isn't on this team.` : others.length > 0 && reports === 0 ? `Nobody on this team reports to ${first} in your people.` : null;
  return text ? <span className="block text-2xs text-[var(--text-tertiary)]">{text}</span> : null;
}

function Members({ node, editing, onOpenPerson }: { node: TeamNode; editing: boolean; onOpenPerson: (id: string) => void }) {
  const { people, createTeam, addTeamMember, endTeamMember } = useCairnStore(useShallow((s) => ({
    people: s.people, createTeam: s.createTeam, addTeamMember: s.addTeamMember, endTeamMember: s.endTeamMember,
  })));
  const { group } = node;
  const leadId = group.info?.leadPersonId;
  const members = [...group.people].sort((a, b) => Number(b.id === leadId) - Number(a.id === leadId));
  const here = new Set(group.people.map((p) => p.id));
  const others = people.filter((p) => !here.has(p.id));
  const teamId = async () => group.info?.id ?? (await createTeam({ name: group.team }))?.id ?? null;
  const add = async (personId: string) => {
    const id = await teamId();
    if (id) await addTeamMember({ teamId: id, personId });
  };
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
            onChange={(id) => void add(id)}
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
            const role = group.roles[p.id];
            const sub = [role ?? p.title, rel ? (rel.label || RELATIONSHIP_LABELS[rel.type]) : null].filter(Boolean).join(" · ");
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
                {editing && group.info && (
                  <BlurInput
                    ariaLabel={`${p.name}'s role on ${group.team}`} placeholder="Role" value={role ?? ""} className="w-28 py-0.5 text-2xs"
                    onSave={(v) => void addTeamMember({ teamId: group.info!.id, personId: p.id, role: v.trim() || null })}
                  />
                )}
                {editing && group.info && (
                  <IconButton label={`Take ${p.name} off ${group.team}`} size="sm" onClick={() => void endTeamMember(group.info!.id, p.id)}><X size={12} /></IconButton>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Who used to be on the team, newest leaver first. */
function PastMembers({ node, onOpenPerson }: { node: TeamNode; onOpenPerson: (id: string) => void }) {
  const { people, memberships } = useCairnStore(useShallow((s) => ({ people: s.people, memberships: s.teamMemberships })));
  const teamId = node.group.info?.id;
  const past = useMemo(() => {
    if (!teamId) return [];
    const now = new Set(node.group.people.map((p) => p.id));
    return memberships
      .filter((m) => m.teamId === teamId && m.endedAt && !now.has(m.personId))
      .map((m) => ({ m, p: people.find((x) => x.id === m.personId) }))
      .filter((x): x is { m: typeof x.m; p: NonNullable<typeof x.p> } => !!x.p)
      .sort((a, b) => b.m.endedAt!.localeCompare(a.m.endedAt!));
  }, [memberships, people, teamId, node.group.people]);
  if (past.length === 0) return null;
  return (
    <section aria-label="Past members" className="mt-8">
      <PanelHeading title="Past members" note={String(past.length)} />
      <ul className="space-y-0.5">
        {past.map(({ m, p }) => (
          <li key={m.id}>
            <button type="button" onClick={() => onOpenPerson(p.id)} className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left hover:bg-[var(--surface-2)]", FOCUS_RING)}>
              <PersonAvatar name={p.name} isMe={p.isMe} size="xs" />
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]">{p.name}</span>
              <span className="text-2xs text-[var(--text-tertiary)]">
                {m.startedAt ? `${formatDate(m.startedAt)} – ` : "Left "}{formatDate(m.endedAt!)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TeamSettings({ node, all, onGone }: { node: TeamNode; all: TeamNode[]; onGone: (into?: string) => void }) {
  const { people, updateTeam, deleteTeam, mergeTeams } = useCairnStore(useShallow((s) => ({
    people: s.people, updateTeam: s.updateTeam, deleteTeam: s.deleteTeam, mergeTeams: s.mergeTeams,
  })));
  const info = node.group.info!;
  const [error, setError] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");

  // A team can't sit under itself or anything below it.
  const below = new Set(flattenTeams([node]).map((n) => n.group.key));
  const parents = all.filter((n) => !below.has(n.group.key) && n.group.key !== NO_TEAM_KEY && n.group.info);
  const others = all.filter((n) => n.group.key !== node.group.key && n.group.info);
  const here = new Set(node.group.people.map((p) => p.id));

  const save = async (patch: Parameters<typeof updateTeam>[1]) => {
    setError(null);
    const out = await updateTeam(info.id, patch);
    if (!out) setError("Couldn't save that. A team with that name may already exist.");
    return out;
  };

  // Link edits run one at a time, each on the list as it stands after the one before:
  // a link added while another is still saving would otherwise write the old list over it.
  const linkQueue = useRef<Promise<unknown>>(Promise.resolve());
  const editLinks = (change: (links: TeamLink[]) => TeamLink[]) => {
    const run = linkQueue.current.then(() => {
      const current = useCairnStore.getState().teams.find((t) => t.id === info.id)?.links ?? [];
      return save({ links: change(current) });
    });
    linkQueue.current = run.catch(() => null);
    return run;
  };
  const addLink = async () => {
    const url = linkUrl.trim();
    if (!isUrl(url)) { setError("Links need a full address, starting with https://"); return; }
    const label = linkLabel.trim();
    // Keep what was typed until the save goes through, so a failure can be retried.
    if (await editLinks((links) => [...links, { label, url }])) { setLinkUrl(""); setLinkLabel(""); }
  };

  return (
    <section className="@container mb-9" aria-label="Team details">
      <PanelHeading title="Details" note="Saved as you change them" />
      {error && <p role="alert" className="mb-2 text-2xs text-[var(--danger)]">{error}</p>}
      <Field label="Name">
        <BlurInput ariaLabel="Team name" value={info.name} onSave={(v) => { if (v.trim()) void save({ name: v }); }} />
      </Field>
      <Field label="Kind">
        <Select<TeamKind>
          ariaLabel="Kind of team" value={info.kind} className="w-full"
          options={TEAM_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          onChange={(k) => void save({ kind: k })}
        />
        <p className="mt-1 text-2xs text-[var(--text-tertiary)]">Someone has one team. Guilds, projects and committees sit beside it.</p>
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
              .sort((a, b) => Number(here.has(b.id)) - Number(here.has(a.id)))
              .map((p) => ({ value: p.id, label: p.name, group: here.has(p.id) ? "On this team" : "Everyone else", keywords: p.title })),
          ]}
          onChange={(id) => void save({ leadPersonId: id || null })}
        />
      </Field>
      <Field label="Sits under">
        <Select<string>
          ariaLabel="Team it sits under"
          value={info.parentTeamId ?? ""}
          className="w-full"
          options={[{ value: "", label: "Nothing (a top-level team)" }, ...parents.map((n) => ({ value: n.group.key, label: [...n.path, n.group.team].join(" › ") }))]}
          onChange={(v) => void save({ parentTeamId: v || null })}
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
                <IconButton label={`Remove ${l.label}`} size="sm" onClick={() => void editLinks((links) => links.filter((x) => x.url !== l.url))}><X size={12} /></IconButton>
              </li>
            ))}
          </ul>
        )}
        <form className="flex flex-wrap gap-1.5" onSubmit={(e) => { e.preventDefault(); void addLink(); }}>
          <Input aria-label="Link address" placeholder="https://…" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} className="min-w-0 flex-[2] text-xs" />
          <Input aria-label="Link name" placeholder="Name (optional)" value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} className="min-w-0 flex-1 text-xs" />
          <Button type="submit" size="xs" variant="outline" disabled={!linkUrl.trim()}>Add</Button>
        </form>
      </Field>
      {others.length > 0 && (
        <Field label="Merge into">
          <Select<string>
            ariaLabel="Merge this team into" value="" className="w-full"
            options={[{ value: "", label: "Keep it its own team" }, ...others.map((n) => ({ value: n.group.key, label: [...n.path, n.group.team].join(" › ") }))]}
            onChange={async (v) => { if (v && (await mergeTeams(v, info.id))) onGone(v); }}
          />
          <p className="mt-1 text-2xs text-[var(--text-tertiary)]">Its members, their roles and dates, and the teams under it move to the other team.</p>
        </Field>
      )}
      <div className="mt-4 flex justify-end">
        <ConfirmButton
          variant="ghost" size="xs" confirmLabel={`Delete ${info.name}? Its members and history go with it`}
          onConfirm={async () => { if (await deleteTeam(info.id)) onGone(); }}
        >
          Delete team
        </ConfirmButton>
      </div>
    </section>
  );
}
