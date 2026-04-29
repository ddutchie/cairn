"use client";

import React, { useEffect, useRef, useCallback, useState } from "react";
import { RefreshCw, Calendar, LayoutDashboard } from "lucide-react";
import type { Note } from "@/types";
import { cn, formatRelative } from "@/lib/utils";

interface DashboardViewProps {
  note: Note;
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

// Bootstrap script injected into every dashboard.
// Provides window.cairn.query(tool, args) → Promise<result>
const BOOTSTRAP = `<script>
(function() {
  var _seq = 0;
  var _pending = {};
  window.addEventListener('message', function(e) {
    var d = e.data;
    if (d && d.type === 'cairn:response' && _pending[d.id]) {
      var cb = _pending[d.id];
      delete _pending[d.id];
      if (d.error) cb.reject(new Error(d.error));
      else cb.resolve(d.result);
    }
  });
  window.cairn = {
    query: function(tool, args) {
      return new Promise(function(resolve, reject) {
        var id = 'q' + (++_seq);
        _pending[id] = { resolve: resolve, reject: reject };
        window.parent.postMessage({ type: 'cairn:query', id: id, tool: tool, args: args || {} }, '*');
        setTimeout(function() {
          if (_pending[id]) { delete _pending[id]; reject(new Error('cairn.query timeout')); }
        }, 10000);
      });
    }
  };
})();
<\/script>`;

function buildSrcdoc(html: string): string {
  if (!html.trim()) return "";
  // Inject bootstrap right after opening <head>, or prepend if no <head>
  if (html.includes("<head>")) {
    return html.replace("<head>", "<head>" + BOOTSTRAP);
  }
  if (html.includes("<html>")) {
    return html.replace("<html>", "<html><head>" + BOOTSTRAP + "</head>");
  }
  return BOOTSTRAP + html;
}

export function DashboardView({ note }: DashboardViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [srcdoc, setSrcdoc] = useState(() => buildSrcdoc(note.content ?? ""));
  const [rev, setRev] = useState(0);

  // Rebuild srcdoc when note content changes
  useEffect(() => {
    setSrcdoc(buildSrcdoc(note.content ?? ""));
  }, [note.id, note.content]);

  const reload = useCallback(() => {
    setSrcdoc(buildSrcdoc(note.content ?? ""));
    setRev((r) => r + 1);
  }, [note.content]);

  // postMessage bridge — forward cairn:query from iframe to electron IPC
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const electron = (window as any).electron;

    async function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || data.type !== "cairn:query") return;

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
          : { error: "Live query bridge not yet available" };
        reply(result);
      } catch (err) {
        reply(null, String(err));
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

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

      {/* Sandboxed iframe — srcdoc avoids all blob/CSP issues */}
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
