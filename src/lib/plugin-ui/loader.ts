/**
 * Renderer-side UI-plugin loader. Pulls each enabled UI plugin's source from
 * main (plugins:listUi), evaluates it into a module exporting `activate(ui)`,
 * and activates it against the Cairn plugin-UI API. Re-pulls on plugins:ui-changed
 * so a UI plugin authored/edited while the app runs loads live.
 *
 * Two source formats are supported:
 *  - CJS (module.exports / require) — evaluated via `new Function`. `require`
 *    resolves the platform module table (react, react/jsx-runtime, react-dom…),
 *    which is what real dsh community client bundles (tsdown CJS) expect.
 *  - ESM (export / import) — evaluated via a Blob module URL + dynamic import();
 *    bare imports are rewritten onto the same platform table (exposed as a
 *    global) since a blob URL can't resolve bare specifiers.
 *
 * Evaluating plugin source is a code-exec surface — dev-gated (CAIRN_PLUGINS_DEV).
 */
import { activateUIPlugin, deactivateUIPlugin, activeUIPluginIds, type UIPluginModule } from "./api";
import type { DshClientPlugin } from "./dsh-client-ctx";
type PluginModule = UIPluginModule | DshClientPlugin;
import { createPlatformModules, KNOWN_UNPROVIDED } from "./platform-modules";

interface ElectronUiPlugins {
  plugins?: {
    listUi: () => Promise<Array<{ id: string; source: string }>>;
    onUiChanged: (cb: () => void) => () => void;
  };
}

// The shared platform module table (react, react/jsx-runtime, react-dom…),
// resolved by the plugin `require` shim.
const PLATFORM = createPlatformModules();

function makeRequire(id: string) {
  return (name: string): unknown => {
    if (name in PLATFORM) return PLATFORM[name];
    if (KNOWN_UNPROVIDED.has(name)) {
      throw new Error(`[plugin-ui] '${id}' require('${name}') — this dsh-client module isn't provided to plugins yet (use the ui API / ui.React for now).`);
    }
    throw new Error(`[plugin-ui] '${id}' require('${name}') is not allowed.`);
  };
}

/** Heuristic: does the source use ESM module syntax (export / top-level import)? */
function isEsm(source: string): boolean {
  // Ignore matches inside strings/comments only loosely — good enough: real
  // plugins either use `export`/`import ... from` at statement level or CJS.
  return /^\s*export\s|[\n;]\s*export\s|^\s*import\s.+\sfrom\s|[\n;]\s*import\s.+\sfrom\s/m.test(source);
}

/** Transpile ESM plugin source into a CJS-shaped body we can run via the same
 *  `new Function(module, exports, require, React, …)` path — so there is ONE
 *  eval path and NO blob: module import (which Cairn's CSP script-src forbids).
 *
 *  - `import …` → `const … = require('spec')` (named / namespace / default)
 *  - `export function activate` / `export const x` → assigns to `exports`
 *  - `export default X` → `module.exports.default = X`
 *  Relative imports aren't supported (a plugin bundle shouldn't have any). */
function esmToCjs(source: string): string {
  let out = source;

  // imports → require(...)
  out = out.replace(
    /import\s+([^;'"]+?)\s+from\s*['"]([^'"]+)['"]\s*;?/g,
    (_full, clause: string, spec: string) => {
      const req = `require(${JSON.stringify(spec)})`;
      const c = clause.trim();
      if (c.startsWith("* as ")) return `const ${c.slice(5).trim()} = ${req};`;
      if (c.startsWith("{")) {
        const inner = namedBindings(c);
        return `const { ${inner} } = ${req};`;
      }
      const [def, named] = c.split(/,(.+)/);
      let line = `const ${def.trim()} = (${req}).default ?? ${req};`;
      if (named) line += ` const { ${namedBindings(named)} } = ${req};`;
      return line;
    },
  );
  // side-effect import: `import 'x'` → require('x')
  out = out.replace(/import\s*['"]([^'"]+)['"]\s*;?/g, (_f, spec: string) => `require(${JSON.stringify(spec)});`);

  // export named declarations → declare + assign onto exports
  out = out.replace(/export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    (_f, asyncKw = "", nm: string) => `${asyncKw}function ${nm}`);
  out = out.replace(/export\s+(const|let|var|class)\s+([A-Za-z0-9_$]+)/g,
    (_f, kind: string, nm: string) => `${kind} ${nm}`);
  // Collect names that were `export`ed (function/const/let/var/class) and append
  // exports assignments so the module surface is populated.
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  // export { a, b as c }
  out = out.replace(/export\s*\{([^}]*)\}\s*;?/g, (_f, inner: string) => {
    const assigns: string[] = [];
    for (const part of inner.split(",")) {
      const t = part.trim(); if (!t) continue;
      const mm = t.match(/^(\S+)\s+as\s+(\S+)$/);
      if (mm) assigns.push(`exports[${JSON.stringify(mm[2])}] = ${mm[1]};`);
      else assigns.push(`exports[${JSON.stringify(t)}] = ${t};`);
    }
    return assigns.join(" ");
  });
  // export default X
  out = out.replace(/export\s+default\s+/g, "module.exports.default = ");

  let tail = "";
  for (const n of names) tail += `\nexports[${JSON.stringify(n)}] = ${n};`;
  return out + tail;
}

function namedBindings(clause: string): string {
  return clause.replace(/^\{|\}$/g, "").split(",").map((p) => {
    const m = p.trim().match(/^(\S+)\s+as\s+(\S+)$/);
    return m ? `${m[1]}: ${m[2]}` : p.trim();
  }).filter(Boolean).join(", ");
}

function evalCjs(id: string, source: string): PluginModule | null {
  const module = { exports: {} as Record<string, unknown> };
  try {
    // Only module/exports/require are injected (the CommonJS trio). React is
    // obtained via require("react") — NOT a magic param — so a plugin that does
    // `const React = require("react")` (dsh bundles, ours) never collides with a
    // wrapper param.
    const fn = new Function("module", "exports", "require", source);
    fn(module, module.exports, makeRequire(id));
    // Accept the Cairn-native shape (activate) OR the dsh client shape (apply).
    // The default export (some bundles) is unwrapped too.
    const raw = module.exports as Record<string, unknown>;
    const mod = (raw.activate || raw.apply ? raw : (raw.default as Record<string, unknown> | undefined)) as (Record<string, unknown>) | undefined;
    if (!mod || (typeof mod.activate !== "function" && typeof mod.apply !== "function")) {
      console.error(`[plugin-ui] '${id}' must export activate(ui) or apply(ctx)`);
      return null;
    }
    return mod as unknown as PluginModule;
  } catch (err) {
    console.error(`[plugin-ui] '${id}' failed to evaluate:`, err);
    return null;
  }
}

/** Evaluate a plugin module. ESM is transpiled to CJS first, then both go
 *  through the single `new Function` path (no blob: import → no CSP change). */
function evalPluginModule(id: string, source: string): PluginModule | null {
  const src = isEsm(source) ? esmToCjs(source) : source;
  return evalCjs(id, src);
}

let started = false;

/** Load + activate all UI plugins, and keep them live-synced. Idempotent. */
export function startUIPlugins(): void {
  if (started) return;
  const el = (globalThis as unknown as { electron?: ElectronUiPlugins }).electron;
  if (!el?.plugins) return; // not in Electron, or dev flag off (handler returns [])
  started = true;

  const reload = async () => {
    let list: Array<{ id: string; source: string }> = [];
    try {
      list = await el.plugins!.listUi();
    } catch (err) {
      console.error("[plugin-ui] listUi failed:", err);
      return;
    }
    const desired = new Set(list.map((p) => p.id));
    for (const id of activeUIPluginIds()) {
      if (!desired.has(id)) deactivateUIPlugin(id);
    }
    for (const p of list) {
      const mod = evalPluginModule(p.id, p.source);
      if (mod) activateUIPlugin(p.id, mod);
    }
  };

  void reload();
  el.plugins.onUiChanged(() => void reload());
}

/** Exposed for unit tests: the ESM → CJS transpile. */
export const esmToCjsForTest = esmToCjs;
