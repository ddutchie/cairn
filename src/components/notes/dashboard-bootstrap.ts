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

// CSS custom-property names to forward from the parent document into the iframe.
export const CAIRN_CSS_VARS = [
  "--background", "--foreground",
  "--surface", "--surface-2", "--surface-3",
  "--border", "--border-subtle",
  "--accent", "--accent-hover", "--accent-dim",
  "--muted", "--muted-fg",
  "--text-primary", "--text-secondary", "--text-tertiary",
  "--success", "--warning", "--danger", "--info",
  "--font-sans", "--font-mono",
] as const;

/**
 * Read the current computed values of all Cairn CSS vars from the parent
 * document and return a <style> block that re-declares them on :root inside
 * the sandboxed iframe. Also forwards data-theme so dashboards can use
 * [data-theme="light"] selectors.
 */
export function buildThemeStyle(theme: string, vars: Record<string, string>): string {
  const declarations = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return (
    `<style id="cairn-theme">` +
    `:root {\n${declarations}\n}` +
    `html, body { background-color: var(--background) !important; color: var(--text-primary); }` +
    `</style>` +
    `<script>document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});<\/script>`
  );
}

export function buildSrcdoc(
  html: string,
  projectId: string,
  workspaceId: string,
  themeInjection = "",
): string {
  if (!html.trim()) return "";
  const bootstrap = buildBootstrap(projectId, workspaceId);
  const head = themeInjection + bootstrap;
  if (html.includes("<head>")) return html.replace("<head>", "<head>" + head);
  if (html.includes("<html>")) return html.replace("<html>", "<html><head>" + head + "</head>");
  return head + html;
}
