"use client";

import { useState, useEffect, useRef } from "react";
import { X, Search, FileText, CheckSquare } from "lucide-react";
import type { IdeaNodeType } from "@/types";
import { useCairnStore } from "@/store";
import { cn } from "@/lib/utils";
import { PRIORITY_COLORS } from "@/lib/utils";

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
  }[type];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-[var(--surface)] border border-[var(--border)] rounded-2xl shadow-xl w-full max-w-sm p-5 z-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X size={14} />
          </button>
        </div>

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
            <>
              <Field label="URL" value={fields.url ?? ""} onChange={(v) => set("url", v)} placeholder="https://..." autoFocus />
              <Field label="Title" value={fields.title ?? ""} onChange={(v) => set("title", v)} />
              <Field label="Description" value={fields.description ?? ""} onChange={(v) => set("description", v)} multiline />
            </>
          )}

          {type === "ai_summary" && (
            <Field label="Content" value={fields.content ?? ""} onChange={(v) => set("content", v)} multiline autoFocus />
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
    </div>
  );
}

// ── Note picker ───────────────────────────────────────────────────────────────

function NotePicker({ selectedId, onSelect }: { selectedId: string; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { notes, activeProjectId } = useCairnStore();

  useEffect(() => { inputRef.current?.focus(); }, []);

  const projectNotes = notes.filter(
    (n) => n.projectId === activeProjectId && !n.archivedAt && n.type === "note"
  );

  const filtered = query.trim()
    ? projectNotes.filter((n) => n.title.toLowerCase().includes(query.toLowerCase()))
    : projectNotes;

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[11px] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">Search notes</label>
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter notes…"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg pl-7 pr-2.5 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        />
      </div>
      <div className="flex flex-col max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
        {filtered.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-[var(--text-tertiary)] text-center">No notes found</p>
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
                <span className="ml-auto text-[10px] text-[var(--accent)] font-medium shrink-0">Selected</span>
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
  const { cards, columns, activeProjectId } = useCairnStore();

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
      <label className="text-[11px] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">Search tasks</label>
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tasks…"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg pl-7 pr-2.5 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        />
      </div>
      <div className="flex flex-col max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
        {filtered.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-[var(--text-tertiary)] text-center">No tasks found</p>
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
                    "text-[10px] px-1 py-0.5 rounded border border-[var(--border)]",
                    PRIORITY_COLORS[c.priority as keyof typeof PRIORITY_COLORS]
                  )}>
                    {c.priority}
                  </span>
                )}
                <span className="text-[10px] text-[var(--text-tertiary)]">{columnName(c.columnId)}</span>
              </div>
              {selectedId === c.id && (
                <span className="text-[10px] text-[var(--accent)] font-medium shrink-0">✓</span>
              )}
            </button>
          ))
        )}
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
  const base = "w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] resize-none";
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">{label}</label>
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
