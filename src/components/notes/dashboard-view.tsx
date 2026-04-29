"use client";

import React, { useEffect, useRef, useCallback, useState } from "react";
import { RefreshCw, Calendar, LayoutDashboard, AlertTriangle, X, Zap } from "lucide-react";
import type { Note } from "@/types";
import { cn, formatRelative } from "@/lib/utils";

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

// Build the bootstrap script with context constants injected.
// Provides:
//   window.cairn.projectId        — active project ID
//   window.cairn.workspaceId      — active workspace ID
//   window.cairn.query(tool,args) — raw Promise-based bridge
//   window.cairn.getProjectSummary(projectId?)
//   window.cairn.listTasks(projectId?)
//   window.cairn.listNotes(projectId?)
//   window.cairn.listRecentActivity(opts?)
//   window.cairn.searchTasks(query, projectId?)
//   window.cairn.searchNotes(query, projectId?)
//   window.cairn.getContext()
function buildBootstrap(projectId: string, workspaceId: string): string {
  return `<script>
(function() {
  var _seq = 0;
  var _pending = {};

  // ── message bus ──────────────────────────────────────────
  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d) return;
    if (d.type === 'cairn:response' && _pending[d.id]) {
      var cb = _pending[d.id];
      delete _pending[d.id];
      if (d.error) cb.reject(new Error(d.error));
      else cb.resolve(d.result);
    }
  });

  // ── error bridge — send JS errors to parent ───────────────
  window.addEventListener('error', function(e) {
    window.parent.postMessage({
      type: 'cairn:error',
      message: e.message || String(e),
      source: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error && e.error.stack,
    }, '*');
  });
  window.addEventListener('unhandledrejection', function(e) {
    var msg = (e.reason && e.reason.message) ? e.reason.message : String(e.reason);
    window.parent.postMessage({
      type: 'cairn:error',
      message: 'Unhandled promise rejection: ' + msg,
      stack: e.reason && e.reason.stack,
    }, '*');
  });
  // Patch console.error to forward to parent
  var _origError = console.error.bind(console);
  console.error = function() {
    _origError.apply(console, arguments);
    var msg = Array.from(arguments).map(function(a) {
      return (a && a.message) ? a.message : String(a);
    }).join(' ');
    window.parent.postMessage({ type: 'cairn:error', message: 'console.error: ' + msg }, '*');
  };

  // ── raw query ─────────────────────────────────────────────
  function query(tool, args) {
    return new Promise(function(resolve, reject) {
      var id = 'q' + (++_seq);
      _pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ type: 'cairn:query', id: id, tool: tool, args: args || {} }, '*');
      setTimeout(function() {
        if (_pending[id]) { delete _pending[id]; reject(new Error('cairn.query timeout: ' + tool)); }
      }, 10000);
    });
  }

  // ── typed helpers ─────────────────────────────────────────
  window.cairn = {
    projectId:   '${projectId}',
    workspaceId: '${workspaceId}',
    query: query,

    getProjectSummary: function(projectId) {
      return query('get_project_summary', { projectId: projectId || '${projectId}' });
    },
    listTasks: function(projectId) {
      return query('list_tasks', { projectId: projectId || '${projectId}' });
    },
    listNotes: function(projectId) {
      return query('list_notes', { projectId: projectId || '${projectId}' });
    },
    listRecentActivity: function(opts) {
      return query('list_recent_activity', Object.assign({ workspaceId: '${workspaceId}', projectId: '${projectId}' }, opts || {}));
    },
    searchTasks: function(q, projectId) {
      return query('search_tasks', { query: q, projectId: projectId || '${projectId}' });
    },
    searchNotes: function(q, projectId) {
      return query('search_notes', { query: q, projectId: projectId || '${projectId}' });
    },
    getContext: function() {
      return query('get_cairn_context', {});
    },
  };
})();
<\/script>`;
}

function buildSrcdoc(html: string, projectId: string, workspaceId: string): string {
  if (!html.trim()) return "";
  const bootstrap = buildBootstrap(projectId, workspaceId);
  if (html.includes("<head>")) return html.replace("<head>", "<head>" + bootstrap);
  if (html.includes("<html>")) return html.replace("<html>", "<html><head>" + bootstrap + "</head>");
  return bootstrap + html;
}

export function DashboardView({ note }: DashboardViewProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const electron = typeof window !== "undefined" ? (window as any).electron : null;

  const projectId   = note.projectId   ?? "";
  const workspaceId = note.workspaceId ?? "";

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [rev, setRev]         = useState(0);
  const [srcdoc, setSrcdoc]   = useState(() => buildSrcdoc(note.content ?? "", projectId, workspaceId));
  const [errors, setErrors]   = useState<DashboardError[]>([]);
  const [autoRefreshed, setAutoRefreshed] = useState(false);

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

  // Auto-refresh when DB changes (db:changed event from Electron)
  useEffect(() => {
    if (!electron?.onDbChanged) return;
    const unsub = electron.onDbChanged(() => {
      // Bump rev to reload the iframe with fresh data — srcdoc stays the same,
      // the dashboard JS will re-run its cairn.query() calls on mount.
      setRev((r) => r + 1);
      setAutoRefreshed(true);
      setTimeout(() => setAutoRefreshed(false), 1500);
    });
    return () => unsub?.();
  }, [electron]);

  // postMessage bridge — forward cairn:query and cairn:error from iframe
  useEffect(() => {
    async function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (!data) return;

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
            <button
              onClick={() => setErrors([])}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={13} />
            </button>
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
      <div className="flex-1 min-h-0 overflow-hidden">
        <iframe
          key={rev}
          ref={iframeRef}
          className="w-full h-full border-0"
          sandbox="allow-scripts"
          srcDoc={srcdoc}
          title={note.title}
        />
      </div>
    </div>
  );
}
