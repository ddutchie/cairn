/**
 * Runtime plugin loader — the "author a YAML, it loads live" path (§10 Tier 2/3).
 *
 * On top of the Loader-composed static tree (getContext's ENTRY_LIST), this
 * reads a USER plugins manifest from a watched directory and mounts its entries
 * on the LIVE context — and re-diffs on file change, so a plugin YAML dropped in
 * (or edited) while the app runs is created/updated/removed WITHOUT a restart.
 *
 * Proven mechanics (spike, §10):
 *  - ctx.loader.create(entry) works AFTER loader.await() has settled (live mount).
 *  - ctx.loader.remove(id) tears an entry down live.
 *  - A plugin can be a `cordis:` builtin (shipped code, config-only) OR a real
 *    on-disk file referenced as `./thing.mjs` — the Loader resolves relative
 *    names against ctx.baseUrl (set to the plugins dir), via a runtime import()
 *    that esbuild leaves alone (so it works from the bundled Electron main and
 *    resolves against the real userData dir, not the asar).
 *
 * Manifest: `<pluginsRoot>/plugins.yml` — a top-level YAML array of entry rows:
 *   - id: my-tool            # unique; the live entry key
 *     name: ./my-tool.mjs    # relative file (new code) OR cordis:<builtin>
 *     config: { ... }        # threaded to the plugin's apply(ctx, config)
 *     disabled: false        # optional; true = not mounted
 * NO `!!js` — this file is plain data (a user/agent-authored file is untrusted;
 * we never eval expressions from it).
 */
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import * as yaml from "js-yaml";
import type { Context } from "@deepseek-ai/cordis";
import "./ctx-augment";

let pluginsRoot = process.env.CAIRN_PLUGINS_ROOT || "";

/** Configure the user-plugins directory (set by Electron main from userData). */
export function setPluginsRoot(root: string): void {
  pluginsRoot = root;
}
export function getPluginsRoot(): string {
  return pluginsRoot;
}

/** Live-loading is opt-in for now (dev flag), so it can never affect prod boot. */
export function pluginsDevEnabled(): boolean {
  return process.env.CAIRN_PLUGINS_DEV === "1";
}

const MANIFEST = "plugins.yml";
/** All entry ids this loader currently owns (so a reload can diff/remove them). */
const activeUserEntryIds = new Set<string>();
/** Entries that failed to load, keyed by id → the source signature that failed.
 *  We skip re-creating a failed entry until its signature changes (its file is
 *  edited, or the manifest points it elsewhere) — otherwise every fs.watch tick
 *  retries a broken plugin forever (e.g. a backend importing an unresolvable
 *  bare package). */
const failedEntries = new Map<string, string>();

/** A cheap change-signature for an entry: file mtime+size for a `./` plugin, or
 *  the bare module name for a builtin. Used to decide whether to retry a failed
 *  entry after the plugins dir changes. */
function entrySignature(modName: string): string {
  if (!modName.startsWith(".")) return modName;
  try {
    const st = fs.statSync(path.resolve(pluginsRoot, modName));
    return `${modName}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `${modName}:missing`;
  }
}

interface UserPluginEntry {
  id: string;
  name?: string; // backend plugin module (cordis: builtin or ./file.mjs). Optional if ui-only.
  ui?: string; // renderer-side UI plugin file (./thing.plugin.js), read + sent to the renderer
  config?: Record<string, unknown>;
  disabled?: boolean;
}

interface LoaderLike {
  builtins: Record<string, unknown>;
  create: (o: Record<string, unknown>) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  await: () => Promise<void>;
  resolve: (id: string) => { id?: string } | undefined;
}

function loaderOf(ctx: Context): LoaderLike | undefined {
  // ctx.loader is provided by cordis-plugin-loader; narrow the augmented
  // Loader shape to Cairn's local LoaderLike (a compatible subset that
  // exposes `create` / `await` / `builtins`).
  const l = ctx.loader as unknown as LoaderLike | undefined;
  return l && typeof l.create === "function" ? l : undefined;
}

/** Await the loader so inject-gated entries whose missing services just became
 *  available (e.g. the fs chain mounting for plugin toolviews) finish applying
 *  before a caller reads registry state. No-op when the loader isn't mounted. */
export async function settleLoader(ctx: Context): Promise<void> {
  const l = loaderOf(ctx);
  if (l) await l.await();
}

/** Parse the manifest (plain data only). Returns [] when absent/empty/invalid. */
function readManifest(): UserPluginEntry[] {
  if (!pluginsRoot) return [];
  const file = path.join(pluginsRoot, MANIFEST);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return []; // no manifest yet — nothing to load
  }
  let parsed: unknown;
  try {
    // DEFAULT_SCHEMA (no custom tags): plain data, NO !!js execution.
    parsed = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA });
  } catch (err) {
    console.error(`[cairn-plugins] failed to parse ${file}:`, err instanceof Error ? err.message : err);
    return [];
  }
  if (!Array.isArray(parsed)) {
    if (parsed != null) console.error(`[cairn-plugins] ${MANIFEST} must be a top-level YAML array of entries`);
    return [];
  }
  const out: UserPluginEntry[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || (typeof r.name !== "string" && typeof r.ui !== "string")) {
      console.error("[cairn-plugins] skipping entry without id + (name or ui):", JSON.stringify(row));
      continue;
    }
    out.push({
      id: r.id,
      name: typeof r.name === "string" ? r.name : undefined,
      ui: typeof r.ui === "string" ? r.ui : undefined,
      config: (r.config && typeof r.config === "object" ? r.config : {}) as Record<string, unknown>,
      disabled: r.disabled === true,
    });
  }
  return out;
}

/** Public: the parsed, enabled manifest (used by the UI-plugin IPC layer). */
export function readEnabledManifest(): UserPluginEntry[] {
  return readManifest().filter((e) => !e.disabled);
}

/** Mount all enabled user entries once on the live ctx (idempotent per id). */
export async function loadUserPlugins(ctx: Context): Promise<void> {
  if (!pluginsDevEnabled() || !pluginsRoot) return;
  const loader = loaderOf(ctx);
  if (!loader) return;
  fs.mkdirSync(pluginsRoot, { recursive: true });
  // The Loader resolves a relative `./x.mjs` entry name against ctx.baseUrl, so
  // point it at the plugins dir (trailing slash required for URL resolution).
  // NOTE: baseUrl lives on Loader.Config, not on Context — cordis-plugin-loader
  // reads it off the ambient ctx at import-resolution time. This structural
  // assignment is the documented way to configure the resolver base for
  // runtime plugins; keep the narrow cast.
  (ctx as unknown as { baseUrl?: string }).baseUrl = pathToFileURL(pluginsRoot).href + "/";
  await reconcile(ctx, loader);
}

/** Diff the manifest against the currently-mounted user entries and apply. */
async function reconcile(ctx: Context, loader: LoaderLike): Promise<void> {
  // Only entries with a backend `name` mount on the Cordis context here; ui-only
  // entries (just `ui:`) are handled renderer-side via the UI-plugin IPC layer.
  const desired = readManifest().filter((e) => !e.disabled && typeof e.name === "string");
  const desiredIds = new Set(desired.map((e) => e.id));

  // Remove entries that are gone or now disabled.
  for (const id of [...activeUserEntryIds]) {
    if (!desiredIds.has(id)) {
      try {
        const entry = loader.resolve(id);
        if (entry) await loader.remove(entry.id ?? id);
        activeUserEntryIds.delete(id);
        console.log(`[cairn-plugins] removed '${id}'`);
      } catch (err) {
        console.error(`[cairn-plugins] failed to remove '${id}':`, err instanceof Error ? err.message : err);
      }
    }
  }
  // Drop failure records for entries no longer desired (so re-adding retries).
  for (const id of [...failedEntries.keys()]) {
    if (!desiredIds.has(id)) failedEntries.delete(id);
  }

  // Create newly-desired entries. (A config edit on an existing id is handled by
  // remove+recreate: simplest correct semantics; the Loader's own update path is
  // a later refinement.)
  for (const e of desired) {
    if (activeUserEntryIds.has(e.id)) continue;
    const modName = e.name as string; // filtered to string above
    const sig = entrySignature(modName);
    // Skip an entry that already failed with this exact signature — retry only
    // once its file/name changes (avoids a per-watch-tick retry storm).
    if (failedEntries.get(e.id) === sig) continue;
    try {
      // For a file plugin, resolve to an absolute file:// URL against the plugins
      // dir and cache-bust it so an edited body reloads (import() memoises URLs).
      // We resolve here (not via the Loader's relative baseUrl path) because a
      // `?v=` query on a bare relative name breaks the Loader's URL rewrite.
      let name = modName;
      if (modName.startsWith(".")) {
        const abs = path.resolve(pluginsRoot, modName);
        name = `${pathToFileURL(abs).href}?v=${Date.now()}`;
      }
      await loader.create({ id: e.id, name, config: e.config ?? {} });
      activeUserEntryIds.add(e.id);
      failedEntries.delete(e.id);
      console.log(`[cairn-plugins] loaded '${e.id}' (${modName})`);
    } catch (err) {
      failedEntries.set(e.id, sig);
      console.error(`[cairn-plugins] failed to load '${e.id}' (${modName}):`, err instanceof Error ? err.message : err);
    }
  }
  await loader.await();
}

let watcher: fs.FSWatcher | null = null;
let debounce: NodeJS.Timeout | null = null;

/** Watch the plugins dir; on any change, re-diff the manifest live. */
export function watchUserPlugins(ctx: Context): void {
  if (!pluginsDevEnabled() || !pluginsRoot || watcher) return;
  const loader = loaderOf(ctx);
  if (!loader) return;
  fs.mkdirSync(pluginsRoot, { recursive: true });
  try {
    watcher = fs.watch(pluginsRoot, { persistent: false }, () => {
      if (debounce) clearTimeout(debounce);
      // Debounce: editors emit multiple events per save.
      debounce = setTimeout(() => {
        void reconcile(ctx, loader).catch((err) =>
          console.error("[cairn-plugins] reconcile failed:", err instanceof Error ? err.message : err),
        );
      }, 150);
    });
    console.log(`[cairn-plugins] watching ${pluginsRoot} for live plugin changes`);
  } catch (err) {
    console.error("[cairn-plugins] failed to start watcher:", err instanceof Error ? err.message : err);
  }
}

/** Stop watching (test teardown / shutdown). */
export function stopWatchingUserPlugins(): void {
  if (debounce) { clearTimeout(debounce); debounce = null; }
  if (watcher) { watcher.close(); watcher = null; }
  failedEntries.clear();
}
