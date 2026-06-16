"use client";

import React, { useEffect, useRef, useCallback, useState } from "react";
import { RefreshCw, Calendar, LayoutDashboard, AlertTriangle, X, Zap, Code2, Wand2, Save, HelpCircle, ChevronLeft } from "lucide-react";
import type { Note, DashboardQueryMessage } from "@/types";
import { cn, formatRelative } from "@/lib/utils";
import { buildSrcdoc, buildThemeStyle, CAIRN_CSS_VARS } from "./dashboard-bootstrap";
import { CairnEvents } from "@/lib/events";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { DashboardApiModal } from "./DashboardApiModal";
import { Button } from "@/components/ui/button";

interface DashboardViewProps {
  note: Note;
  onBack?: () => void;
}

interface DashboardError {
  message: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
}

// Read current Cairn CSS vars + theme from the DOM
function readThemeInjection(): string {
  if (typeof window === "undefined") return "";
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of CAIRN_CSS_VARS) {
    const val = style.getPropertyValue(name).trim();
    if (val) vars[name] = val;
  }
  const theme = document.documentElement.getAttribute("data-theme") ?? "dark";
  return buildThemeStyle(theme, vars);
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

export function DashboardView({ note, onBack }: DashboardViewProps) {
  const electron = typeof window !== "undefined" ? window.electron : null;
  const { updateNote, aiConfig } = useCairnStore(useShallow((s) => ({ updateNote: s.updateNote, aiConfig: s.aiConfig })));
  const aiEnabled = aiConfig.aiEnabled ?? true;

  const projectId   = note.projectId   ?? "";
  const workspaceId = note.workspaceId ?? "";

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const cmViewRef = useRef<import("@codemirror/view").EditorView | null>(null);
  const [rev, setRev]                       = useState(0);
  const [themeInjection, setThemeInjection] = useState(() => readThemeInjection());
  const [srcdoc, setSrcdoc]                 = useState(() => buildSrcdoc(note.content ?? "", projectId, workspaceId, readThemeInjection()));
  const [errors, setErrors]                 = useState<DashboardError[]>([]);
  const [autoRefreshed, setAutoRefreshed]   = useState(false);
  const [editOpen, setEditOpen]             = useState(false);
  const [apiModalOpen, setApiModalOpen]     = useState(false);

  // Watch for theme changes (data-theme on <html>) and re-read CSS vars
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setThemeInjection(readThemeInjection());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // Rebuild srcdoc when note content or theme changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSrcdoc(buildSrcdoc(note.content ?? "", projectId, workspaceId, themeInjection));
    setErrors([]);
  }, [note.id, note.content, projectId, workspaceId, themeInjection]);

  const reload = useCallback(() => {
    const injection = readThemeInjection();
    setSrcdoc(buildSrcdoc(note.content ?? "", projectId, workspaceId, injection));
    setErrors([]);
    setRev((r) => r + 1);
  }, [note.content, projectId, workspaceId]);

  // Auto-refresh when DB changes — send cairn:refresh to iframe instead of remounting
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

      if (data.type === "cairn:error") {
        setErrors((prev) => [
          { message: data.message, source: data.source, line: data.line, col: data.col, stack: data.stack },
          ...prev.slice(0, 4),
        ]);
        return;
      }

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
      const { syntaxHighlighting, HighlightStyle } = await import("@codemirror/language");
      const { tags } = await import("@lezer/highlight");

      const isDark = document.documentElement.getAttribute("data-theme") !== "light";

      // Palette matched to CodeBlock.tsx dark/light palettes
      const highlightStyle = HighlightStyle.define(isDark ? [
        { tag: [tags.tagName, tags.angleBracket],        color: "#e06c75" },
        { tag: tags.attributeName,                        color: "#e06c75" },
        { tag: tags.attributeValue,                       color: "#98c379" },
        { tag: [tags.string, tags.special(tags.string)],  color: "#98c379" },
        { tag: tags.comment,                              color: "#5c6370", fontStyle: "italic" },
        { tag: tags.docComment,                            color: "#c678dd" },
        { tag: [tags.keyword, tags.operator],             color: "#56b6c2" },
        { tag: tags.number,                               color: "#d19a66" },
        { tag: tags.url,                                  color: "#98c379" },
        { tag: tags.punctuation,                          color: "#abb2bf" },
        { tag: tags.meta,                                 color: "#61afef" },
      ] : [
        { tag: [tags.tagName, tags.angleBracket],        color: "#dc2626" },
        { tag: tags.attributeName,                        color: "#1d4ed8" },
        { tag: tags.attributeValue,                       color: "#16a34a" },
        { tag: [tags.string, tags.special(tags.string)],  color: "#16a34a" },
        { tag: tags.comment,                              color: "#9ca3af", fontStyle: "italic" },
        { tag: tags.docComment,                            color: "#7c3aed" },
        { tag: [tags.keyword, tags.operator],             color: "#0891b2" },
        { tag: tags.number,                               color: "#c2410c" },
        { tag: tags.url,                                  color: "#16a34a" },
        { tag: tags.punctuation,                          color: "#374151" },
        { tag: tags.meta,                                 color: "#1d4ed8" },
      ]);

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
            syntaxHighlighting(highlightStyle),
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
      <div className="flex flex-wrap md:flex-nowrap items-center justify-between gap-2.5 px-4 py-2 md:py-0 md:h-9 border-b border-[var(--border)] flex-shrink-0">
        <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
          {onBack && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="md:hidden gap-1.5 pl-1.5 pr-2.5 h-8 text-[var(--text-secondary)] mr-1"
            >
              <ChevronLeft size={14} />
              <span>Notes</span>
            </Button>
          )}
          <LayoutDashboard size={12} />
          <span className="font-medium text-[var(--text-secondary)]">Dashboard</span>
          {autoRefreshed && (
            <span className="flex items-center gap-1 text-[var(--accent)] animate-pulse">
              <Zap size={9} /> live
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[0.786rem] text-[var(--text-tertiary)] flex items-center gap-1">
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
            <div className="flex items-center gap-1.5 text-[0.786rem] font-semibold text-[var(--danger)] uppercase tracking-wider">
              <AlertTriangle size={11} />
              Dashboard error{errors.length > 1 ? `s (${errors.length})` : ""}
            </div>
            <div className="flex items-center gap-1">
              {aiEnabled && (
                <button
                  onClick={() => {
                    const errorSummary = errors.map((e) =>
                      `- ${e.message}${e.source ? ` (${e.source.split("/").pop()}:${e.line}:${e.col})` : ""}`
                    ).join("\n");
                    const prefill = `My dashboard has the following error${errors.length > 1 ? "s" : ""}:\n\n${errorSummary}\n\nHere is the current dashboard HTML:\n\n\`\`\`html\n${note.content ?? ""}\n\`\`\`\n\nPlease fix it.`;
                    window.dispatchEvent(CairnEvents.openChat(prefill));
                    setErrors([]);
                  }}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[0.786rem] text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors"
                >
                  <Wand2 size={11} />
                  Fix with AI
                </button>
              )}
              <button
                onClick={() => setErrors([])}
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors p-0.5"
              >
                <X size={13} />
              </button>
            </div>
          </div>
          {errors.map((err, i) => (
            <div key={i} className="text-[0.786rem] font-mono text-[var(--danger)]/80 leading-relaxed">
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

        {/* Edit HTML drawer */}
        {editOpen && (
          <div className="absolute inset-0 flex flex-col bg-[var(--background)] z-10">
            {/* Drawer header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                  <Code2 size={12} />
                  Edit HTML
                </div>
                <button
                  onClick={() => setApiModalOpen(true)}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.786rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
                  title="window.cairn API reference"
                >
                  <HelpCircle size={11} />
                  API ref
                </button>
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

      {/* API reference modal */}
      {apiModalOpen && <DashboardApiModal onClose={() => setApiModalOpen(false)} />}
    </div>
  );
}
