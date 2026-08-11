"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { Link2, ChevronDown, FileText, Kanban, X, Tag as TagIcon, Plus, Sparkles } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { OverflowPill } from "@/components/ui/overflow-pill";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import type { Note, Tag } from "@/types";

interface SemanticHit {
  noteId: string;
  title: string;
  score: number;
  sectionTitle: string;
}

export interface BacklinksPanelProps {
  note: Note;
  onOpenCard: () => void;
  semanticEnabled?: boolean;
  semanticContent?: string;
  activeSectionTitle?: string | null;
  activeSectionText?: string | null;
  workspaceId?: string | null;
}

export function BacklinksPanel({
  note,
  onOpenCard,
  semanticEnabled = false,
  semanticContent,
  activeSectionTitle,
  activeSectionText,
  workspaceId,
}: BacklinksPanelProps) {
  const { notes, cards, columns } = useCairnStore(useShallow((s) => ({
    notes: s.notes,
    cards: s.cards,
    columns: s.columns,
  })));
  const [open, setOpen] = useState(false);

  const debouncedSemantic = useDebouncedValue(semanticContent ?? "", 1200);
  const debouncedSectionText = useDebouncedValue(activeSectionText ?? "", 1200);

  type SearchState = { kind: "loading" } | { kind: "results"; hits: SemanticHit[] };
  const [search, setSearch] = useState<SearchState | null>(null);
  const [sectionSearch, setSectionSearch] = useState<SearchState | null>(null);
  const trimmedSemanticLength = (semanticContent ?? "").trim().length;
  const canSearch = semanticEnabled && !!workspaceId && trimmedSemanticLength >= 4;
  const canSectionSearch = semanticEnabled && !!workspaceId && !!activeSectionTitle && debouncedSectionText.trim().length >= 20;

  useEffect(() => {
    const trimmed = debouncedSemantic.trim();
    if (!canSearch || trimmed.length < 4) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const api = window.electron?.embeddings;
      if (!api) return;
      setSearch({ kind: "loading" });
      try {
        const hits = await api.search(workspaceId!, trimmed, {
          queryNoteId: note.id,
          k: 5,
        });
        if (!cancelled) setSearch({ kind: "results", hits });
      } catch {
        if (!cancelled) setSearch({ kind: "results", hits: [] });
      }
    })();
    return () => {
      cancelled = true;
      setSearch(null);
    };
  }, [canSearch, debouncedSemantic, note.id, workspaceId]);

  useEffect(() => {
    if (!canSectionSearch) return;
    let cancelled = false;
    void (async () => {
      const api = window.electron?.embeddings;
      if (!api) return;
      setSectionSearch({ kind: "loading" });
      try {
        const hits = await api.search(workspaceId!, debouncedSectionText.trim(), {
          queryNoteId: note.id,
          k: 3,
        });
        if (!cancelled) setSectionSearch({ kind: "results", hits });
      } catch {
        if (!cancelled) setSectionSearch({ kind: "results", hits: [] });
      }
    })();
    return () => {
      cancelled = true;
      setSectionSearch(null);
    };
  }, [canSectionSearch, debouncedSectionText, note.id, workspaceId]);

  const sectionHits = canSectionSearch && sectionSearch?.kind === "results" ? sectionSearch.hits : [];
  const sectionLoading = canSectionSearch && sectionSearch?.kind === "loading";
  const sectionNoteIds = new Set(sectionHits.map((h) => h.noteId));
  const semanticHits = search?.kind === "results" ? search.hits.filter((h) => !sectionNoteIds.has(h.noteId)) : [];
  const semanticLoading = search?.kind === "loading";

  const linkedNotes = useMemo(
    () => (note.linkedNoteIds ?? []).map((id) => notes.find((n) => n.id === id)).filter(Boolean) as Note[],
    [note.linkedNoteIds, notes],
  );
  const linkedCards = useMemo(
    () => (note.linkedCardIds ?? []).map((id) => cards.find((c) => c.id === id)).filter(Boolean) as import("@/types").TaskCard[],
    [note.linkedCardIds, cards],
  );

  const wikilinkBacklinks = useMemo(() => {
    const titleLower = note.title.toLowerCase();
    const re = /\[\[([^\][\n]+?)\]\]/g;
    return notes.filter((n) => {
      if (n.id === note.id) return false;
      if ((note.linkedNoteIds ?? []).includes(n.id)) return false;
      const content = n.content ?? "";
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(content)) !== null) {
        if (m[1].trim().toLowerCase() === titleLower) return true;
      }
      return false;
    });
  }, [note.id, note.title, note.linkedNoteIds, notes]);

  const semanticCount = semanticEnabled ? semanticHits.length + sectionHits.length : 0;
  const total = linkedNotes.length + linkedCards.length + wikilinkBacklinks.length + semanticCount;
  const hasSemanticActivity = semanticCount > 0 || semanticLoading || sectionLoading;
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!hasSemanticActivity) {
      autoOpenedRef.current = false;
      return;
    }
    if (!autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setOpen(true);
    }
  }, [hasSemanticActivity]);
  const noteId = note.id;
  useEffect(() => {
    autoOpenedRef.current = false;
  }, [noteId]);
  if (total === 0 && !semanticLoading && !semanticEnabled) return null;

  return (
    <div className="flex-shrink-0 border-t border-[var(--border)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-6 py-2.5 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
      >
        {semanticCount > 0 ? <Sparkles size={11} className="text-[var(--accent)]" /> : <Link2 size={11} />}
        <span className="flex-1 text-left">
          {semanticCount > 0
            ? `${semanticCount} similar + ${total - semanticCount} backlink${(total - semanticCount) !== 1 ? "s" : ""}`
            : `${total} backlink${total !== 1 ? "s" : ""}`}
        </span>
        {semanticLoading && <span className="text-[0.714rem] animate-pulse">…</span>}
        <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-6 pb-3 space-y-1">
          {semanticEnabled && (semanticLoading || semanticHits.length > 0 || (semanticHits.length === 0 && linkedNotes.length === 0 && linkedCards.length === 0 && wikilinkBacklinks.length === 0)) && (
            <>
              <div className="flex items-center gap-1.5 mt-1 mb-0.5 text-[0.714rem] text-[var(--accent)]">
                <Sparkles size={10} />
                <span className="uppercase tracking-wider font-medium">Semantic</span>
                {semanticLoading && <span className="text-[var(--text-tertiary)] animate-pulse">searching…</span>}
              </div>
              {!semanticLoading && semanticHits.length === 0 && (
                <div className="px-2 py-1 text-[0.714rem] text-[var(--text-tertiary)]">
                  No similar notes found. Reindex from Settings → Embeddings to refresh.
                </div>
              )}
              {semanticHits.map((hit) => (
                <button
                  key={hit.noteId}
                  onClick={() => window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: hit.noteId } }))}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--surface-2)] text-xs text-[var(--text-secondary)] transition-colors text-left"
                >
                  <Sparkles size={11} className="text-[var(--accent)] flex-shrink-0 opacity-70" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{hit.title || "Untitled"}</div>
                    {hit.sectionTitle && (
                      <div className="truncate text-[0.65rem] text-[var(--accent)] opacity-70 mt-0.5">
                        {hit.sectionTitle}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <div className="flex-1 h-1 rounded-full bg-[var(--surface-3)] overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)] rounded-full transition-all"
                          style={{ width: `${Math.round(hit.score * 100)}%` }}
                        />
                      </div>
                      <span className="text-[0.65rem] text-[var(--text-tertiary)] font-mono">{hit.score.toFixed(2)}</span>
                    </div>
                  </div>
                </button>
              ))}
              {activeSectionTitle && (sectionLoading || sectionHits.length > 0) && (
                <>
                  <div className="flex items-center gap-1.5 mt-2 mb-0.5 text-[0.714rem] text-[var(--accent)] opacity-80">
                    <span className="truncate">Related to &ldquo;{activeSectionTitle}&rdquo;</span>
                    {sectionLoading && <span className="animate-pulse">…</span>}
                  </div>
                  {sectionHits.map((hit) => (
                    <button
                      key={hit.noteId}
                      onClick={() => window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: hit.noteId } }))}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--surface-2)] text-xs text-[var(--text-secondary)] transition-colors text-left"
                    >
                      <Sparkles size={11} className="text-[var(--accent)] flex-shrink-0 opacity-50" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{hit.title || "Untitled"}</div>
                        {hit.sectionTitle && (
                          <div className="truncate text-[0.65rem] text-[var(--accent)] opacity-60 mt-0.5">
                            {hit.sectionTitle}
                          </div>
                        )}
                      </div>
                      <span className="text-[0.65rem] text-[var(--text-tertiary)] font-mono flex-shrink-0">{hit.score.toFixed(2)}</span>
                    </button>
                  ))}
                </>
              )}
              {(linkedNotes.length > 0 || linkedCards.length > 0 || wikilinkBacklinks.length > 0) && (
                <div className="h-px bg-[var(--border)] my-1" />
              )}
            </>
          )}
          {linkedNotes.map((n) => (
            <button
              key={n.id}
              onClick={() => window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: n.id } }))}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--surface-2)] text-xs text-[var(--text-secondary)] transition-colors text-left"
            >
              <FileText size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
              <span className="truncate flex-1">{n.title}</span>
              <span className="text-[0.714rem] text-[var(--text-tertiary)]">note</span>
            </button>
          ))}
          {linkedCards.map((c) => {
            const col = columns.find((col) => col.id === c.columnId);
            return (
              <button
                key={c.id}
                onClick={onOpenCard}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--surface-2)] text-xs text-[var(--text-secondary)] transition-colors text-left"
              >
                <Kanban size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
                <span className="truncate flex-1">{c.title}</span>
                <span className="text-[0.714rem] text-[var(--text-tertiary)]">{col?.name ?? "card"}</span>
              </button>
            );
          })}
          {wikilinkBacklinks.length > 0 && (
            <>
              {(linkedNotes.length > 0 || linkedCards.length > 0) && (
                <div className="h-px bg-[var(--border)] my-1" />
              )}
              {wikilinkBacklinks.map((n) => (
                <button
                  key={n.id}
                  onClick={() => window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: n.id } }))}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--surface-2)] text-xs text-[var(--text-secondary)] transition-colors text-left"
                >
                  <Link2 size={11} className="text-[var(--accent)] flex-shrink-0" />
                  <span className="truncate flex-1">{n.title}</span>
                  <span className="text-[0.714rem] text-[var(--accent)] opacity-70">wikilink</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export interface NoteTagBarProps {
  note: Note;
  workspaceTags: Tag[];
  onToggleTag: (tagId: string) => void;
  onCreateTag: (name: string) => void;
  getTagById: (id: string) => Tag | undefined;
}

export function NoteTagBar({ note, workspaceTags, onToggleTag, onCreateTag, getTagById }: NoteTagBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
        setNewTagName("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [pickerOpen]);

  useEffect(() => {
    if (pickerOpen) inputRef.current?.focus();
  }, [pickerOpen]);

  // Close on Escape regardless of focus (consistent with other overlays).
  useEscapeKey(() => { setPickerOpen(false); setNewTagName(""); }, pickerOpen);

  const assignedTags = note.tagIds.map((id) => getTagById(id)).filter(Boolean) as Tag[];
  const unassignedTags = workspaceTags.filter((t) => !note.tagIds.includes(t.id));
  const filteredUnassigned = newTagName
    ? unassignedTags.filter((t) => t.name.toLowerCase().includes(newTagName.toLowerCase()))
    : unassignedTags;

  const shownAssigned = tagsExpanded ? assignedTags : assignedTags.slice(0, 5);
  const hiddenAssigned = assignedTags.slice(shownAssigned.length);

  function handleCreateTag() {
    const trimmed = newTagName.trim();
    if (!trimmed) return;
    onCreateTag(trimmed);
    setNewTagName("");
    setPickerOpen(false);
  }

  return (
    <div className="flex items-center gap-1.5 mt-2.5 max-w-4xl mx-auto flex-wrap relative">
      {shownAssigned.map((tag) => (
        <button
          key={tag.id}
          onClick={() => onToggleTag(tag.id)}
          className="group flex items-center gap-0.5"
          title={`Remove tag "${tag.name}"`}
        >
          <Badge color={tag.color} size="xs">{tag.name}</Badge>
          <X size={9} className="opacity-0 group-hover:opacity-100 text-[var(--text-tertiary)] transition-opacity -ml-1" />
        </button>
      ))}
      {assignedTags.length > 5 && (
        <OverflowPill
          count={hiddenAssigned.length}
          names={hiddenAssigned.map((t) => t.name)}
          label={tagsExpanded ? "−" : `+${hiddenAssigned.length}`}
          tooltip={tagsExpanded ? "Show fewer tags" : undefined}
          onClick={() => setTagsExpanded((v) => !v)}
        />
      )}

      <div className="relative" ref={pickerRef}>
        <button
          onClick={() => setPickerOpen((o) => !o)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] border border-dashed border-[var(--border)] transition-colors"
        >
          <TagIcon size={11} />
          Add tag
        </button>

        {pickerOpen && (
          <div className="absolute top-full left-0 mt-1 z-20 bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-lg p-2 w-48">
            <input
              ref={inputRef}
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (filteredUnassigned.length === 0 && newTagName.trim()) handleCreateTag();
                  else if (filteredUnassigned.length > 0) { onToggleTag(filteredUnassigned[0].id); setPickerOpen(false); setNewTagName(""); }
                }
              }}
              placeholder="Search or create…"
              className="w-full px-2 py-1 text-xs rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] mb-2"
            />
            <div className="max-h-36 overflow-y-auto space-y-0.5">
              {filteredUnassigned.map((tag) => (
                <button
                  key={tag.id}
                  onClick={() => { onToggleTag(tag.id); setPickerOpen(false); setNewTagName(""); }}
                  className="flex items-center gap-2 w-full px-2 py-1 rounded text-xs hover:bg-[var(--surface-2)] transition-colors text-left"
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
                  <span className="text-[var(--text-secondary)] truncate">{tag.name}</span>
                </button>
              ))}
              {newTagName.trim() && (
                <button
                  onClick={handleCreateTag}
                  className="flex items-center gap-2 w-full px-2 py-1 rounded text-xs hover:bg-[var(--surface-2)] transition-colors text-left text-[var(--accent)]"
                >
                  <Plus size={10} />
                  Create &quot;{newTagName.trim()}&quot;
                </button>
              )}
              {filteredUnassigned.length === 0 && !newTagName.trim() && (
                <p className="text-[0.786rem] text-[var(--text-tertiary)] px-2 py-1">No tags yet</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
