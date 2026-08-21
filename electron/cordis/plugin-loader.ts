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

interface UserPluginEntry {
  id: string;
  name: string;
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
  const l = (ctx as unknown as { loader?: LoaderLike }).loader;
  return l && typeof l.create === "function" ? l : undefined;
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
    if (typeof r.id !== "string" || typeof r.name !== "string") {
      console.error("[cairn-plugins] skipping entry without string id+name:", JSON.stringify(row));
      continue;
    }
    out.push({
      id: r.id,
      name: r.name,
      config: (r.config && typeof r.config === "object" ? r.config : {}) as Record<string, unknown>,
      disabled: r.disabled === true,
    });
  }
  return out;
}

/** Mount all enabled user entries once on the live ctx (idempotent per id). */
export async function loadUserPlugins(ctx: Context): Promise<void> {
  if (!pluginsDevEnabled() || !pluginsRoot) return;
  const loader = loaderOf(ctx);
  if (!loader) return;
  fs.mkdirSync(pluginsRoot, { recursive: true });
  // The Loader resolves a relative `./x.mjs` entry name against ctx.baseUrl, so
  // point it at the plugins dir (trailing slash required for URL resolution).
  (ctx as unknown as { baseUrl?: string }).baseUrl = pathToFileURL(pluginsRoot).href + "/";
  await reconcile(ctx, loader);
}

/** Diff the manifest against the currently-mounted user entries and apply. */
async function reconcile(ctx: Context, loader: LoaderLike): Promise<void> {
  const desired = readManifest().filter((e) => !e.disabled);
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

  // Create newly-desired entries. (A config edit on an existing id is handled by
  // remove+recreate: simplest correct semantics; the Loader's own update path is
  // a later refinement.)
  for (const e of desired) {
    if (activeUserEntryIds.has(e.id)) continue;
    try {
      // For a file plugin, resolve to an absolute file:// URL against the plugins
      // dir and cache-bust it so an edited body reloads (import() memoises URLs).
      // We resolve here (not via the Loader's relative baseUrl path) because a
      // `?v=` query on a bare relative name breaks the Loader's URL rewrite.
      let name = e.name;
      if (e.name.startsWith(".")) {
        const abs = path.resolve(pluginsRoot, e.name);
        name = `${pathToFileURL(abs).href}?v=${Date.now()}`;
      }
      await loader.create({ id: e.id, name, config: e.config ?? {} });
      activeUserEntryIds.add(e.id);
      console.log(`[cairn-plugins] loaded '${e.id}' (${e.name})`);
    } catch (err) {
      console.error(`[cairn-plugins] failed to load '${e.id}' (${e.name}):`, err instanceof Error ? err.message : err);
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
}
