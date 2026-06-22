"use client";

import { useState, useEffect, useRef } from "react";
import { Search, FileText, CheckSquare, Layers, Loader2, DownloadCloud } from "lucide-react";
import type { IdeaNodeType } from "@/types";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { PRIORITY_COLORS } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface NodeEditModalProps {
  nodeId: string;
  type: IdeaNodeType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSave: (nodeId: string, data: Record<string, any>) => void;
  onClose: () => void;
}

export function NodeEditModal({ nodeId, type, data, onSave, onClose }: NodeEditModalProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [fields, setFields] = useState<Record<string, any>>(data);

  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { setFields(data); }, [nodeId]);

  function set(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    onSave(nodeId, fields);
    onClose();
  }

  const title = {
    idea: "Edit idea",
    note_ref: "Link a note",
    task_ref: "Link a task",
    url: "Edit URL",
    ai_summary: "Edit summary",
    group: "Edit group",
  }[type];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm" aria-describedby="node-edit-desc">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div id="node-edit-desc" className="sr-only">
          Form to edit the properties of the selected idea flow node.
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="flex flex-col gap-3">
            {type === "idea" && (
              <>
                <Field label="Title" value={fields.title ?? ""} onChange={(v) => set("title", v)} autoFocus />
                <Field label="Body" value={fields.body ?? ""} onChange={(v) => set("body", v)} multiline />
              </>
            )}

            {type === "note_ref" && (
              <NotePicker
                selectedId={fields.noteId ?? ""}
                onSelect={(id) => set("noteId", id)}
              />
            )}

            {type === "task_ref" && (
              <TaskPicker
                selectedId={fields.cardId ?? ""}
                onSelect={(id) => set("cardId", id)}
              />
            )}

            {type === "url" && (
              <UrlEditor
                url={fields.url ?? ""}
                title={fields.title ?? ""}
                description={fields.description ?? ""}
                onUrlChange={(v) => set("url", v)}
                onTitleChange={(v) => set("title", v)}
                onDescriptionChange={(v) => set("description", v)}
              />
            )}

            {type === "ai_summary" && (
              <Field label="Content" value={fields.content ?? ""} onChange={(v) => set("content", v)} multiline autoFocus />
            )}

            {type === "group" && (
              <GroupEditor
                label={fields.label ?? ""}
                color={fields.color ?? "accent"}
                onLabelChange={(v) => set("label", v)}
                onColorChange={(v) => set("color", v)}
              />
            )}
          </div>

          <div className="flex gap-2 mt-5 justify-end">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Note picker ───────────────────────────────────────────────────────────────

function NotePicker({ selectedId, onSelect }: { selectedId: string; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { notes, activeProjectId } = useCairnStore(useShallow((s) => ({ notes: s.notes, activeProjectId: s.activeProjectId })));

  useEffect(() => { inputRef.current?.focus(); }, []);

  const projectNotes = notes.filter(
    (n) => n.projectId === activeProjectId && !n.archivedAt && n.type === "note"
  );

  const filtered = query.trim()
    ? projectNotes.filter((n) => n.title.toLowerCase().includes(query.toLowerCase()))
    : projectNotes;

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[0.786rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">Search notes</label>
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter notes…"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg pl-7 pr-2.5 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none"
        />
      </div>
      <div className="flex flex-col max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
        {filtered.length === 0 ? (
          <p className="px-3 py-3 text-[0.786rem] text-[var(--text-tertiary)] text-center">No notes found</p>
        ) : (
          filtered.map((n) => (
            <button
              key={n.id}
              onClick={() => onSelect(n.id)}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-left transition-colors",
                selectedId === n.id
                  ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                  : "hover:bg-[var(--surface-2)] text-[var(--text-secondary)]"
              )}
            >
              <FileText size={11} className="shrink-0 text-[var(--text-tertiary)]" />
              <span className="text-xs truncate">{n.title}</span>
              {selectedId === n.id && (
                <span className="ml-auto text-[0.714rem] text-[var(--accent)] font-medium shrink-0">Selected</span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ── Task picker ───────────────────────────────────────────────────────────────

function TaskPicker({ selectedId, onSelect }: { selectedId: string; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { cards, columns, activeProjectId } = useCairnStore(useShallow((s) => ({ cards: s.cards, columns: s.columns, activeProjectId: s.activeProjectId })));

  useEffect(() => { inputRef.current?.focus(); }, []);

  const projectCards = cards.filter(
    (c) => c.projectId === activeProjectId && !c.archivedAt
  );

  const filtered = query.trim()
    ? projectCards.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
    : projectCards;

  function columnName(columnId: string) {
    return columns.find((col) => col.id === columnId)?.name ?? "";
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[0.786rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">Search tasks</label>
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tasks…"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg pl-7 pr-2.5 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none"
        />
      </div>
      <div className="flex flex-col max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
        {filtered.length === 0 ? (
          <p className="px-3 py-3 text-[0.786rem] text-[var(--text-tertiary)] text-center">No tasks found</p>
        ) : (
          filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-left transition-colors",
                selectedId === c.id
                  ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                  : "hover:bg-[var(--surface-2)] text-[var(--text-secondary)]"
              )}
            >
              <CheckSquare size={11} className="shrink-0 text-[var(--text-tertiary)]" />
              <span className="text-xs truncate flex-1">{c.title}</span>
              <div className="flex items-center gap-1 shrink-0 ml-auto">
                {c.priority && (
                  <span className={cn(
                    "text-[0.714rem] px-1 py-0.5 rounded border border-[var(--border)]",
                    PRIORITY_COLORS[c.priority as keyof typeof PRIORITY_COLORS]
                  )}>
                    {c.priority}
                  </span>
                )}
                <span className="text-[0.714rem] text-[var(--text-tertiary)]">{columnName(c.columnId)}</span>
              </div>
              {selectedId === c.id && (
                <span className="text-[0.714rem] text-[var(--accent)] font-medium shrink-0">✓</span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ── URL editor ────────────────────────────────────────────────────────────────

function UrlEditor({
  url, title, description, onUrlChange, onTitleChange, onDescriptionChange,
}: {
  url: string; title: string; description: string;
  onUrlChange: (v: string) => void;
  onTitleChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
}) {
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");

  async function fetchMeta() {
    if (!url || !window.electron?.flow?.url) return;
    setFetching(true);
    setFetchError("");
    try {
      const meta = await window.electron.flow.url.fetch(url);
      if (meta.title)       onTitleChange(meta.title);
      if (meta.description) onDescriptionChange(meta.description);
    } catch (e) {
      setFetchError((e as Error).message ?? "Failed to fetch");
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* URL row with Fetch button */}
      <div className="flex flex-col gap-1">
        <label className="text-[0.786rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">URL</label>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="https://..."
            autoFocus
            className="flex-1 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none min-w-0"
          />
          <button
            type="button"
            onClick={fetchMeta}
            disabled={fetching || !url}
            title="Fetch title & description from URL"
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)] disabled:opacity-40 transition-colors shrink-0"
          >
            {fetching ? <Loader2 size={12} className="animate-spin" /> : <DownloadCloud size={12} />}
            {fetching ? "" : "Fetch"}
          </button>
        </div>
        {fetchError && (
          <p className="text-[0.714rem] text-[var(--danger)]">{fetchError}</p>
        )}
      </div>
      <Field label="Title" value={title} onChange={onTitleChange} />
      <Field label="Description" value={description} onChange={onDescriptionChange} multiline />
    </div>
  );
}

// ── Group editor ──────────────────────────────────────────────────────────────

const GROUP_COLORS: Array<{ value: string; label: string; swatch: string }> = [
  { value: "accent",  label: "Blue",   swatch: "var(--accent)" },
  { value: "purple",  label: "Purple", swatch: "color-mix(in srgb, var(--accent) 60%, transparent)" },
  { value: "green",   label: "Green",  swatch: "var(--success)" },
  { value: "orange",  label: "Orange", swatch: "var(--warning)" },
  { value: "red",     label: "Red",    swatch: "var(--danger)" },
];

function GroupEditor({
  label, color, onLabelChange, onColorChange,
}: {
  label: string; color: string;
  onLabelChange: (v: string) => void;
  onColorChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-[0.786rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide flex items-center gap-1.5">
          <Layers size={10} /> Label
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          autoFocus
          placeholder="Group name…"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[0.786rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">Colour</label>
        <div className="flex items-center gap-2">
          {GROUP_COLORS.map((c) => (
            <button
              key={c.value}
              title={c.label}
              onClick={() => onColorChange(c.value)}
              className={cn(
                "w-6 h-6 rounded-full border-2 transition-transform hover:scale-110",
                color === c.value ? "border-[var(--text-primary)] scale-110" : "border-transparent"
              )}
              style={{ background: c.swatch }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Generic field ─────────────────────────────────────────────────────────────

function Field({
  label, value, onChange, multiline, placeholder, autoFocus,
}: {
  label: string; value: string;
  onChange: (v: string) => void;
  multiline?: boolean; placeholder?: string; autoFocus?: boolean;
}) {
  const base = "w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none resize-none";
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[0.786rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">{label}</label>
      {multiline ? (
        <textarea
          rows={3}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={base}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={base}
        />
      )}
    </div>
  );
}
