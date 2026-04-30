"use client";

import React, { useEffect, useRef, useCallback, useState } from "react";
import { RefreshCw, Calendar, LayoutDashboard, AlertTriangle, X, Zap, Code2, Wand2, Save } from "lucide-react";
import type { Note, DashboardQueryMessage } from "@/types";
import { cn, formatRelative } from "@/lib/utils";
import { buildSrcdoc } from "./dashboard-bootstrap";
import { CairnEvents } from "@/lib/events";
import { useCairnStore } from "@/store";

interface DashboardViewProps {
  note: Note;
}

interface DashboardError {
  message: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
}

// Read-only tools the dashboard is allowed to call
const ALLOWED_TOOLS = new Set([
  "get_cairn_context",
  "search_notes",
  "search_tasks",
  "get_note",
  "get_task",
  "get_project_summary",
  "list_recent_activity",
  "list_notes",
  "list_tasks",
]);

export function DashboardView({ note }: DashboardViewProps) {
  const electron = typeof window !== "undefined" ? window.electron : null;
  const { updateNote } = useCairnStore();

  const projectId   = note.projectId   ?? "";
  const workspaceId = note.workspaceId ?? "";

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const cmViewRef = useRef<import("@codemirror/view").EditorView | null>(null);
  const [rev, setRev]         = useState(0);
  const [srcdoc, setSrcdoc]   = useState(() => buildSrcdoc(note.content ?? "", projectId, workspaceId));
  const [errors, setErrors]   = useState<DashboardError[]>([]);
  const [autoRefreshed, setAutoRefreshed] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  // Rebuild srcdoc when note content changes
  useEffect(() => {
    setSrcdoc(buildSrcdoc(note.content ?? "", projectId, workspaceId));
    setErrors([]);
  }, [note.id, note.content, projectId, workspaceId]);

  const reload = useCallback(() => {
    setSrcdoc(buildSrcdoc(note.content ?? "", projectId, workspaceId));
    setErrors([]);
    setRev((r) => r + 1);
  }, [note.content, projectId, workspaceId]);

  // Auto-refresh when DB changes (db:changed event from Electron).
  // Send cairn:refresh to the iframe instead of remounting (no visible flash).
  useEffect(() => {
    if (!electron?.onDbChanged) return;
    const unsub = electron.onDbChanged(() => {
      iframeRef.current?.contentWindow?.postMessage({ type: "cairn:refresh" }, "*");
      setAutoRefreshed(true);
      setTimeout(() => setAutoRefreshed(false), 1500);
    });
    return () => { unsub(); };
  }, [electron]);

  // postMessage bridge — forward cairn:query and cairn:error from iframe
  useEffect(() => {
    async function handleMessage(event: MessageEvent<DashboardQueryMessage>) {
      const data = event.data;
      if (!data?.type) return;

      // ── error bridge ──
      if (data.type === "cairn:error") {
        setErrors((prev) => [
          { message: data.message, source: data.source, line: data.line, col: data.col, stack: data.stack },
          ...prev.slice(0, 4), // cap at 5
        ]);
        return;
      }

      // ── query bridge ──
      if (data.type !== "cairn:query") return;

      const reply = (result: unknown, error?: string) => {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "cairn:response", id: data.id, result, error },
          "*"
        );
      };

      if (!ALLOWED_TOOLS.has(data.tool)) {
        reply(null, `Tool '${data.tool}' is not allowed in dashboards`);
        return;
      }

      try {
        const result = electron?.mcpQuery
          ? await electron.mcpQuery(data.tool, data.args)
          : { error: "Live query bridge not available" };
        reply(result);
      } catch (err) {
        reply(null, String(err));
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [electron]);

  // ── HTML editor (CodeMirror) ──────────────────────────────────────────────
  useEffect(() => {
    if (!editOpen || !editorRef.current) return;
    let view: import("@codemirror/view").EditorView;

    async function init() {
      const { EditorView, keymap: cmKeymap } = await import("@codemirror/view");
      const { EditorState } = await import("@codemirror/state");
      const { defaultKeymap, history, historyKeymap, indentWithTab } = await import("@codemirror/commands");
      const { html } = await import("@codemirror/lang-html");

      const isDark = document.documentElement.getAttribute("data-theme") !== "light";

      const theme = EditorView.theme({
        "&": { height: "100%", fontSize: "12.5px", fontFamily: "ui-monospace, monospace" },
        ".cm-scroller": { overflow: "auto" },
        ".cm-content": { padding: "12px 16px", caretColor: isDark ? "#e8e4dc" : "#1a1917" },
        ".cm-line": { lineHeight: "1.6" },
        "&.cm-focused .cm-cursor": { borderLeftColor: isDark ? "#7c6af7" : "#6457e8" },
        ".cm-gutters": { display: "none" },
        "&, .cm-gutters": { backgroundColor: isDark ? "#161616" : "#f8f7f5", color: isDark ? "#abb2bf" : "#374151", border: "none" },
        ".cm-selectionBackground, ::selection": { backgroundColor: isDark ? "rgba(124,106,247,0.25)" : "rgba(100,87,232,0.15)" },
      }, { dark: isDark });

      view = new EditorView({
        state: EditorState.create({
          doc: note.content ?? "",
          extensions: [
            history(),
            cmKeymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
            html(),
            theme,
            EditorView.lineWrapping,
          ],
        }),
        parent: editorRef.current!,
      });
      cmViewRef.current = view;
    }

    init();
    return () => { view?.destroy(); cmViewRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editOpen]);

  function handleSaveHtml() {
    const html = cmViewRef.current?.state.doc.toString() ?? "";
    updateNote(note.id, { content: html, contentText: "" });
    setEditOpen(false);
    // reload will fire via note.content change in the srcdoc effect above
  }

  if (!note.content?.trim()) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-[var(--text-tertiary)]">
        <LayoutDashboard size={32} className="opacity-40" />
        <p className="text-sm">This dashboard has no content yet.</p>
        <p className="text-xs opacity-60">Ask the AI to generate a dashboard for this project.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] flex-shrink-0">
        <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
          <LayoutDashboard size={12} />
          <span className="font-medium text-[var(--text-secondary)]">Dashboard</span>
          {autoRefreshed && (
            <span className="flex items-center gap-1 text-[var(--accent)] animate-pulse">
              <Zap size={9} /> live
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-[var(--text-tertiary)] flex items-center gap-1">
            <Calendar size={10} />
            {formatRelative(note.updatedAt)}
          </span>
          <button
            onClick={() => setEditOpen(true)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors",
              "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
            )}
          >
            <Code2 size={11} />
            Edit HTML
          </button>
          <button
            onClick={reload}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors",
              "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
            )}
          >
            <RefreshCw size={11} />
            Reload
          </button>
        </div>
      </div>

      {/* Title */}
      <div className="px-6 pt-4 pb-3 flex-shrink-0 border-b border-[var(--border)]">
        <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight max-w-[680px] mx-auto">
          {note.title}
        </h1>
      </div>

      {/* Error overlay */}
      {errors.length > 0 && (
        <div className="flex-shrink-0 border-b border-[var(--danger)]/30 bg-[var(--danger)]/[0.06] px-4 py-3 space-y-1.5">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--danger)] uppercase tracking-wider">
              <AlertTriangle size={11} />
              Dashboard error{errors.length > 1 ? `s (${errors.length})` : ""}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  const errorSummary = errors.map((e) =>
                    `- ${e.message}${e.source ? ` (${e.source.split("/").pop()}:${e.line}:${e.col})` : ""}`
                  ).join("\n");
                  const prefill = `My dashboard has the following error${errors.length > 1 ? "s" : ""}:\n\n${errorSummary}\n\nHere is the current dashboard HTML:\n\n\`\`\`html\n${note.content ?? ""}\n\`\`\`\n\nPlease fix it.`;
                  window.dispatchEvent(CairnEvents.openChat(prefill));
                  setErrors([]);
                }}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors"
              >
                <Wand2 size={11} />
                Fix with AI
              </button>
              <button
                onClick={() => setErrors([])}
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors p-0.5"
              >
                <X size={13} />
              </button>
            </div>
          </div>
          {errors.map((err, i) => (
            <div key={i} className="text-[11px] font-mono text-[var(--danger)]/80 leading-relaxed">
              <span className="text-[var(--danger)]">{err.message}</span>
              {err.source && (
                <span className="text-[var(--text-tertiary)] ml-2">
                  {err.source.split("/").pop()}:{err.line}:{err.col}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Sandboxed iframe */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <iframe
          key={rev}
          ref={iframeRef}
          className="w-full h-full border-0"
          sandbox="allow-scripts"
          srcDoc={srcdoc}
          title={note.title}
        />

        {/* Edit HTML drawer — slides up from the bottom over the iframe */}
        {editOpen && (
          <div className="absolute inset-0 flex flex-col bg-[var(--background)] z-10">
            {/* Drawer header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] flex-shrink-0">
              <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                <Code2 size={12} />
                Edit HTML
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEditOpen(false)}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
                >
                  <X size={11} />
                  Cancel
                </button>
                <button
                  onClick={handleSaveHtml}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
                >
                  <Save size={11} />
                  Save & reload
                </button>
              </div>
            </div>
            {/* CodeMirror HTML editor */}
            <div ref={editorRef} className="flex-1 min-h-0 overflow-hidden" />
          </div>
        )}
      </div>
    </div>
  );
}
