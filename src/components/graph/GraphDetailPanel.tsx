"use client";

import React, { useMemo, useState } from "react";
import { X, FileText, Kanban, Layers, Hash, ExternalLink, Link2, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { GraphNode } from "@/types";
import { nodeTypeColor } from "@/store/slices/graph";
import { extractWikiLinks } from "@/components/notes/toc-utils";
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";

interface Props {
  node: GraphNode | null;
  onClose: () => void;
}

interface LinkEntry {
  noteId: string;
  title: string;
  weight?: number;
  sourceSectionTitle?: string;
  targetSectionTitle?: string;
}

export function GraphDetailPanel({ node, onClose }: Props) {
  const [linksExpanded, setLinksExpanded] = useState(true);
  const [linkedExpanded, setLinkedExpanded] = useState(true);
  const { setView, setActiveProject, projects, notes, cards, columns, graphData, setSelectedGraphNode } = useCairnStore(useShallow((s) => ({
    setView:             s.setView,
    setActiveProject:    s.setActiveProject,
    projects:            s.projects,
    notes:               s.notes,
    cards:               s.cards,
    columns:             s.columns,
    graphData:           s.graphData,
    setSelectedGraphNode: s.setSelectedGraphNode,
  })));

  const { wikiLinks, semanticLinks } = useMemo(() => {
    if (!node || node.type !== "note") {
      return { wikiLinks: [] as LinkEntry[], semanticLinks: [] as LinkEntry[] };
    }

    // Outgoing wikilinks from the note body, resolved to note IDs
    const note = notes.find((n) => n.id === node.id);
    const fromContent: LinkEntry[] = note?.content
      ? extractWikiLinks(note.content, notes)
          .filter((wl): wl is { title: string; noteId: string } => wl.noteId !== null)
          .map((wl) => ({ noteId: wl.noteId, title: wl.title }))
      : [];

    const fromContentIds = new Set(fromContent.map((l) => l.noteId));

    // Wikilink edges from the graph (incoming + outgoing) not already in content
    const fromGraphWiki: LinkEntry[] = graphData.edges
      .filter((e) => e.type === "wikilink" && (e.source === node.id || e.target === node.id))
      .map((e) => {
        const otherId = e.source === node.id ? e.target : e.source;
        const otherNote = notes.find((n) => n.id === otherId);
        return { noteId: otherId, title: otherNote?.title ?? "Unknown" };
      })
      .filter((l) => !fromContentIds.has(l.noteId));

    // Merge + dedupe by noteId, content-derived first
    const seenWiki = new Set<string>();
    const dedupedWiki: LinkEntry[] = [];
    for (const l of [...fromContent, ...fromGraphWiki]) {
      if (seenWiki.has(l.noteId)) continue;
      seenWiki.add(l.noteId);
      dedupedWiki.push(l);
    }

    // Semantic edges (both directions), sorted by weight desc
    const semantic: LinkEntry[] = graphData.edges
      .filter((e) => e.type === "semantic" && (e.source === node.id || e.target === node.id))
      .map((e) => {
        const otherId = e.source === node.id ? e.target : e.source;
        const otherNote = notes.find((n) => n.id === otherId);
        return {
          noteId: otherId,
          title: otherNote?.title ?? "Unknown",
          weight: e.weight,
          sourceSectionTitle: e.sourceSectionTitle,
          targetSectionTitle: e.targetSectionTitle,
        };
      })
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

    return { wikiLinks: dedupedWiki, semanticLinks: semantic };
  }, [node, notes, graphData.edges]);

  const linkedTaskItems = useMemo(() => {
    if (!node || node.type !== "note") return [];
    const note = notes.find((n) => n.id === node.id);
    if (!note?.linkedCardIds.length) return [];
    return note.linkedCardIds
      .map((id) => cards.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c && !c.archivedAt)
      .map((c) => ({ id: c.id, title: c.title }));
  }, [node, notes, cards]);

  const linkedNoteItems = useMemo(() => {
    if (!node || node.type !== "card") return [];
    const card = cards.find((c) => c.id === node.id);
    if (!card?.linkedNoteIds.length) return [];
    return card.linkedNoteIds
      .map((id) => notes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => !!n && !n.archivedAt)
      .map((n) => ({ id: n.id, title: n.title }));
  }, [node, notes, cards]);

  if (!node) return null;

  const project = projects.find((p) => p.id === (node.projectId ?? node.id));

  function navigateTo() {
    if (!node) return;
    const targetProjectId = node.projectId ?? (node.type === "project" ? node.id : null);
    if (targetProjectId) setActiveProject(targetProjectId);

    switch (node.type) {
      case "project":  setView("overview"); break;
      case "note":     setView("notes"); break;
      case "card":
        setView("board");
        // Defer until after the board mounts and registers its event listeners
        {
          const cardId = node.id;
          requestAnimationFrame(() => {
            const card = cards.find((c) => c.id === cardId);
            const col = card ? columns.find((c) => c.id === card.columnId) : undefined;
            if (col) {
              window.dispatchEvent(new CustomEvent("cairn:scroll-to-column", { detail: { columnId: col.id } }));
            }
            window.dispatchEvent(new CustomEvent("cairn:open-card", { detail: { cardId } }));
          });
        }
        break;
      case "tag":      setView("notes"); break;
    }
    onClose();
  }

  const typeIcon = {
    project: <Layers size={13} />,
    note:    <FileText size={13} />,
    card:    <Kanban size={13} />,
    tag:     <Hash size={13} />,
  }[node.type];

  const typeLabel = {
    project: "Project",
    note:    "Note",
    card:    "Task",
    tag:     "Tag",
  }[node.type];

  function selectNode(noteId: string) {
    const exists = graphData.nodes.find((n) => n.id === noteId);
    if (exists) setSelectedGraphNode(noteId);
  }

  return (
    <div className="w-72 flex-shrink-0 border-l border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="flex items-center gap-1.5 text-xs font-medium px-1.5 py-0.5 rounded"
            style={{
              color: nodeTypeColor(node.type),
              background: `color-mix(in srgb, ${nodeTypeColor(node.type)} 12%, transparent)`,
            }}
          >
            {typeIcon}
            {typeLabel}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 flex flex-col min-h-0 p-4 gap-4">
        {/* Title */}
        <div className="flex-shrink-0">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] leading-snug">
            {node.title}
          </h3>
          {project && node.type !== "project" && (
            <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
              in {project.name}
            </p>
          )}
        </div>

        {/* Snippet */}
        {node.meta?.snippet && (
          <div className="text-xs text-[var(--text-secondary)] leading-relaxed flex-1 min-h-0 overflow-y-auto pr-1 -mx-1">
            <NoteMarkdownPreview content={node.meta.snippet} className="!px-2 !py-0 text-xs" />
          </div>
        )}

        {/* Meta fields */}
        <div className="space-y-1.5 flex-shrink-0">
          {node.meta?.status && (
            <MetaRow label="Status" value={node.meta.status} />
          )}
          {node.meta?.priority && (
            <MetaRow label="Priority" value={node.meta.priority} />
          )}
          {node.meta?.assignee && (
            <MetaRow label="Assignee" value={node.meta.assignee} />
          )}
          {node.meta?.color && node.type === "tag" && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--text-tertiary)] w-16 flex-shrink-0">Colour</span>
              <span
                className="w-3 h-3 rounded-full border border-[var(--border)]"
                style={{ background: node.meta.color }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Linked tasks (note → cards) — pinned, collapsible */}
      {node.type === "note" && linkedTaskItems.length > 0 && (
        <CollapsibleLinkSection
          icon={<Kanban size={12} />}
          label="Linked tasks"
          count={linkedTaskItems.length}
          expanded={linkedExpanded}
          onToggle={() => setLinkedExpanded((v) => !v)}
        >
          {linkedTaskItems.map((item) => {
            const graphNode = graphData.nodes.find((n) => n.id === item.id);
            return (
              <button
                key={item.id}
                onClick={() => graphNode && setSelectedGraphNode(item.id)}
                disabled={!graphNode}
                className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors text-left group disabled:opacity-40 disabled:cursor-default"
              >
                <Kanban size={11} className="text-[var(--text-tertiary)] flex-shrink-0 group-hover:text-[var(--accent)] transition-colors" />
                <span className="truncate">{item.title}</span>
              </button>
            );
          })}
        </CollapsibleLinkSection>
      )}

      {/* Linked notes (card → notes) — pinned, collapsible */}
      {node.type === "card" && linkedNoteItems.length > 0 && (
        <CollapsibleLinkSection
          icon={<FileText size={12} />}
          label="Linked notes"
          count={linkedNoteItems.length}
          expanded={linkedExpanded}
          onToggle={() => setLinkedExpanded((v) => !v)}
        >
          {linkedNoteItems.map((item) => {
            const graphNode = graphData.nodes.find((n) => n.id === item.id);
            return (
              <button
                key={item.id}
                onClick={() => graphNode && setSelectedGraphNode(item.id)}
                disabled={!graphNode}
                className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors text-left group disabled:opacity-40 disabled:cursor-default"
              >
                <FileText size={11} className="text-[var(--text-tertiary)] flex-shrink-0 group-hover:text-[var(--accent)] transition-colors" />
                <span className="truncate">{item.title}</span>
              </button>
            );
          })}
        </CollapsibleLinkSection>
      )}

      {/* Links section — pinned, collapsible */}
      {node.type === "note" && (wikiLinks.length > 0 || semanticLinks.length > 0) && (
        <CollapsibleLinkSection
          icon={<Link2 size={12} />}
          label="Links"
          count={wikiLinks.length + semanticLinks.length}
          expanded={linksExpanded}
          onToggle={() => setLinksExpanded((v) => !v)}
        >
          {/* Wikilinks */}
          {wikiLinks.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1 px-2 text-[var(--text-tertiary)]">
                <Link2 size={11} />
                <span className="text-[0.714rem] font-semibold uppercase tracking-wider">Wikilinks</span>
                <span className="text-[0.643rem] opacity-60">{wikiLinks.length}</span>
              </div>
              <div className="space-y-0.5">
                {wikiLinks.map((link) => (
                  <button
                    key={link.noteId}
                    onClick={() => selectNode(link.noteId)}
                    className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors text-left group"
                  >
                    <FileText size={11} className="text-[var(--text-tertiary)] flex-shrink-0 group-hover:text-[var(--accent)] transition-colors" />
                    <span className="truncate">{link.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Semantic links */}
          {semanticLinks.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1 px-2 text-[var(--text-tertiary)]">
                <Sparkles size={11} />
                <span className="text-[0.714rem] font-semibold uppercase tracking-wider">Semantic</span>
                <span className="text-[0.643rem] opacity-60">{semanticLinks.length}</span>
              </div>
              <div className="space-y-0.5">
                {semanticLinks.slice(0, 10).map((link) => (
                  <button
                    key={link.noteId}
                    onClick={() => selectNode(link.noteId)}
                    className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors text-left group"
                  >
                    <Sparkles size={11} className="text-[var(--text-tertiary)] flex-shrink-0 group-hover:text-[var(--accent)] transition-colors" />
                    <span className="truncate flex-1">{link.title}</span>
                    {link.weight !== undefined && (
                      <span className="text-[0.643rem] text-[var(--text-tertiary)] flex-shrink-0">
                        {Math.round(link.weight * 100)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </CollapsibleLinkSection>
      )}

      {/* Footer CTA */}
      {node.type !== "tag" && (
        <div className="border-t border-[var(--border)] p-3">
          <button
            onClick={navigateTo}
            className={cn(
              "flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-md text-xs font-medium transition-colors",
              "bg-[var(--accent-dim)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white"
            )}
          >
            <ExternalLink size={12} />
            Open in {typeLabel === "Task" ? "Board" : typeLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-[var(--text-tertiary)] w-20 flex-shrink-0 capitalize">{label}</span>
      <span className="text-xs text-[var(--text-secondary)] capitalize">{value}</span>
    </div>
  );
}

function CollapsibleLinkSection({
  icon,
  label,
  count,
  expanded,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-[var(--border)] flex-shrink-0 flex flex-col min-h-0">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 px-4 py-2 w-full text-left hover:bg-[var(--surface-2)] transition-colors"
      >
        <span className="text-[var(--text-tertiary)]">{icon}</span>
        <span className="text-[0.714rem] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
          {label}
        </span>
        <span className="text-[0.643rem] text-[var(--text-tertiary)] opacity-60">{count}</span>
        <span className="ml-auto text-[var(--text-tertiary)]">
          {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </span>
      </button>
      {expanded && (
        <div className="overflow-y-auto max-h-64 px-2 pb-2 space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}
