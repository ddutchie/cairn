"use client";

import React, { useMemo, useState } from "react";
import { BookOpen, Check, ExternalLink, FileText, GitBranch, PenTool, Globe, Hash, Link2, ListChecks, Pencil, Plus, Trash2, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { PanelHeading, SURFACE } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/empty-state";
import { appClient } from "@/lib/ipc/app";
import { cn } from "@/lib/utils";
import {
  PROJECT_LINK_KIND_LABEL, addProjectLinks, connectorForLinkKind, detectProjectLink,
  extractLinkCandidates, removeProjectLinks,
  type ProjectLink, type ProjectLinkInput, type ProjectLinkKind,
} from "@cairn/shared/projects/links";
import type { Project } from "@/types";

const KIND_ICON: Record<ProjectLinkKind, LucideIcon> = {
  confluence: BookOpen,
  jira: ListChecks,
  slack: Hash,
  github: GitBranch,
  figma: PenTool,
  notion: FileText,
  linear: ListChecks,
  drive: FileText,
  url: Globe,
};

function newLinkId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Where this project's material lives: a Confluence space, Slack channels, a Jira
 * project, a repo. The assistant reads these before it searches a connector, so
 * "get the latest docs" goes straight to the right space.
 */
export function ProjectLinksSection({ project }: { project: Project }) {
  const { updateProject, mcpServers } = useCairnStore(useShallow((s) => ({
    updateProject: s.updateProject,
    mcpServers: s.mcpServers,
  })));
  const links = useMemo(() => project.links ?? [], [project.links]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const save = (next: ProjectLink[]) => updateProject(project.id, { links: next });

  const add = (inputs: ProjectLinkInput[]): boolean => {
    const { links: next, rejected } = addProjectLinks(links, inputs, newLinkId);
    if (rejected.length) {
      setError(`Not a web address: ${rejected[0]}`);
      return false;
    }
    setError(null);
    save(next);
    return true;
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (add([{ url: text }])) setDraft("");
  };

  // Web addresses already written in the description, offered as one-click imports.
  const candidates = useMemo(() => extractLinkCandidates(project.description, links), [project.description, links]);
  const detected = draft.trim() ? detectProjectLink(draft) : null;

  return (
    <section className={SURFACE} aria-labelledby={`links-${project.id}`}>
      <PanelHeading
        title={<span id={`links-${project.id}`}>Links</span>}
        note="Where this project's docs, channels and code live. The assistant checks these before searching your connectors."
      />

      {links.length === 0 ? (
        <EmptyState
          title="No links yet"
          description="Paste a Confluence space, Slack channel, Jira project or repo below."
          className="py-4"
        />
      ) : (
        <ul className="space-y-2">
          {links.map((link) => (
            <li key={link.id}>
              {editingId === link.id ? (
                <LinkEditor
                  link={link}
                  onCancel={() => setEditingId(null)}
                  onSave={(patch) => {
                    add([{ url: link.url, ...patch }]);
                    setEditingId(null);
                  }}
                />
              ) : (
                <LinkRow
                  link={link}
                  connector={connectorForLinkKind(link.kind, mcpServers.map((m) => ({ name: m.name, baseUrl: "baseUrl" in m ? m.baseUrl : undefined, enabled: m.enabled })))?.name}
                  onEdit={() => setEditingId(link.id)}
                  onRemove={() => save(removeProjectLinks(links, [link.id]))}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-3 flex items-start gap-2"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        <div className="min-w-0 flex-1">
          <Input
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null); }}
            placeholder="Paste a link"
            aria-label="Add a link"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `links-error-${project.id}` : undefined}
          />
          {error ? (
            <p id={`links-error-${project.id}`} className="mt-1 text-xs text-[var(--danger)]">{error}</p>
          ) : detected && detected.kind !== "url" ? (
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              {PROJECT_LINK_KIND_LABEL[detected.kind]}{detected.ref ? `, ${detected.ref}` : ""}
            </p>
          ) : null}
        </div>
        <Button type="submit" size="sm" disabled={!draft.trim()}>
          <Plus size={12} />
          Add link
        </Button>
      </form>

      {candidates.length > 0 && (
        <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">
          <p className="text-xs text-[var(--text-secondary)]">
            The description mentions {candidates.length === 1 ? "a link" : `${candidates.length} links`}.
          </p>
          <ul className="mt-1.5 space-y-1">
            {candidates.slice(0, 5).map((c) => (
              <li key={c.url} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]" title={c.url}>{c.url}</span>
                <Button size="sm" variant="ghost" onClick={() => add([c])}>Save as link</Button>
              </li>
            ))}
          </ul>
          {candidates.length > 1 && (
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => add(candidates.slice(0, 50))}>
              Save all {candidates.length}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function LinkRow({ link, connector, onEdit, onRemove }: {
  link: ProjectLink;
  connector?: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const Icon = KIND_ICON[link.kind] ?? Link2;
  return (
    <div className="group flex items-start gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3 shadow-elev-1 hover:bg-[var(--surface-3)] transition-colors">
      <span
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)]"
        aria-hidden="true"
      >
        <Icon size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium break-words">{link.label}</span>
          <span className="text-2xs text-[var(--text-tertiary)]">{PROJECT_LINK_KIND_LABEL[link.kind]}</span>
          {link.ref && (
            <span className="rounded border border-[var(--border-subtle)] px-1 text-2xs font-mono text-[var(--text-secondary)]">{link.ref}</span>
          )}
          {connector && (
            <Tooltip content={`${connector} is connected, so the assistant can read this directly`}>
              <span className="inline-flex items-center gap-1 text-2xs text-[var(--text-tertiary)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" aria-hidden="true" />
                {connector}
              </span>
            </Tooltip>
          )}
        </div>
        {link.note && <p className="mt-0.5 text-xs text-[var(--text-secondary)] break-words">{link.note}</p>}
        <p className="mt-0.5 truncate text-2xs text-[var(--text-tertiary)]" title={link.url}>{link.url}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label="Open link" size="sm" onClick={() => { void appClient.openExternal(link.url); }}>
          <ExternalLink size={13} />
        </IconButton>
        <IconButton label="Edit link" size="sm" onClick={onEdit}>
          <Pencil size={13} />
        </IconButton>
        <IconButton label="Remove link" size="sm" onClick={onRemove}>
          <Trash2 size={13} />
        </IconButton>
      </div>
    </div>
  );
}

function LinkEditor({ link, onSave, onCancel }: {
  link: ProjectLink;
  onSave: (patch: { label: string; ref: string; note: string }) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(link.label);
  const [ref, setRef] = useState(link.ref ?? "");
  const [note, setNote] = useState(link.note ?? "");
  return (
    <form
      className={cn("space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 shadow-elev-1")}
      onSubmit={(e) => { e.preventDefault(); onSave({ label, ref, note }); }}
    >
      <p className="truncate text-2xs text-[var(--text-tertiary)]" title={link.url}>{link.url}</p>
      <Input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label" placeholder="Label" />
      <Input value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Reference" placeholder="Space key, channel id, project key" className="font-mono" />
      <Input value={note} onChange={(e) => setNote(e.target.value)} aria-label="What it is for" placeholder="What it is for" />
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}><X size={12} />Cancel</Button>
        <Button type="submit" size="sm"><Check size={12} />Save</Button>
      </div>
    </form>
  );
}
