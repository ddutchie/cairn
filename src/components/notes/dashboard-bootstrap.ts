/**
 * Cairn — Dashboard bootstrap script
 *
 * This module builds the injected <script> block that runs inside
 * sandboxed dashboard iframes. It provides:
 *
 *   window.cairn.projectId        — active project ID
 *   window.cairn.workspaceId      — active workspace ID
 *   window.cairn.query(tool,args) — raw Promise-based bridge
 *   window.cairn.getProjectSummary(projectId?)
 *   window.cairn.listTasks(projectId?)
 *   window.cairn.listNotes(projectId?)
 *   window.cairn.listRecentActivity(opts?)
 *   window.cairn.searchTasks(query, projectId?)
 *   window.cairn.searchNotes(query, projectId?)
 *   window.cairn.getContext()
 *
 * On receiving a `cairn:refresh` postMessage the dashboard re-invokes
 * its data-fetch functions without a full remount — no visible flash.
 *
 * IDs are injected via JSON.stringify() to prevent injection.
 */

export function buildBootstrap(projectId: string, workspaceId: string): string {
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
    // cairn:refresh — notify the dashboard to re-fetch its data
    if (d.type === 'cairn:refresh' && typeof window._cairnOnRefresh === 'function') {
      window._cairnOnRefresh();
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
  var _pid = ${JSON.stringify(projectId)};
  var _wid = ${JSON.stringify(workspaceId)};
  window.cairn = {
    projectId:   _pid,
    workspaceId: _wid,
    query: query,

    getProjectSummary: function(projectId) {
      return query('get_project_summary', { projectId: projectId || _pid });
    },
    listTasks: function(projectId) {
      return query('list_tasks', { projectId: projectId || _pid });
    },
    listNotes: function(projectId) {
      return query('list_notes', { projectId: projectId || _pid });
    },
    listRecentActivity: function(opts) {
      return query('list_recent_activity', Object.assign({ workspaceId: _wid, projectId: _pid }, opts || {}));
    },
    searchTasks: function(q, projectId) {
      return query('search_tasks', { query: q, projectId: projectId || _pid });
    },
    searchNotes: function(q, projectId) {
      return query('search_notes', { query: q, projectId: projectId || _pid });
    },
    getContext: function() {
      return query('get_cairn_context', {});
    },
  };
})();
<\/script>`;
}

export function buildSrcdoc(html: string, projectId: string, workspaceId: string): string {
  if (!html.trim()) return "";
  const bootstrap = buildBootstrap(projectId, workspaceId);
  if (html.includes("<head>")) return html.replace("<head>", "<head>" + bootstrap);
  if (html.includes("<html>")) return html.replace("<html>", "<html><head>" + bootstrap + "</head>");
  return bootstrap + html;
}
