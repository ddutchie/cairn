/**
 * Plugin installer — the C2 "Add plugin from GitHub" flow (§20).
 *
 * Fetches a plugin package, extracts it under <pluginsRoot>/installed/<id>/,
 * reads its package.json `dsh` section (dsh community-plugin manifest), and
 * appends a managed entry to plugins.yml so the loader picks it up live.
 *
 * A dsh community plugin's package.json declares:
 *   "main": "lib/index.js"                     → the backend tool module
 *   "exports": { "./client": "./lib/client.js" } → the renderer UI half
 *   "dsh": { "bundle": { "patch": "…" }, "client": { … } }
 * We map these to a Cairn plugins.yml row:
 *   { id, name: ./installed/<id>/<main>, ui: ./installed/<id>/<client> }
 *
 * dsh-visualize commits its built lib/, so there is NO build step — the files
 * are used as-shipped. Building-from-source packages are rejected (clear error).
 *
 * NOTE: fetching + running third-party code is a code-exec surface. This is a
 * DEVELOPER-PREVIEW feature (CAIRN_PLUGINS_DEV=1) and must warn "trusted sources
 * only" until the Tier-3 untrusted-code sandbox exists (docs/plans §10.8).
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import * as yaml from "js-yaml";
import { createRequire } from "module";
import { getPluginsRoot } from "./plugin-loader";

const INSTALLED_DIR = "installed";
const MANIFEST = "plugins.yml";

export interface InstallResult {
  id: string;
  name: string | null; // backend entry (relative to pluginsRoot) or null
  ui: string | null; // ui entry (relative to pluginsRoot) or null
  kind: "ui" | "backend" | "both";
}

interface ParsedSpec {
  kind: "github" | "local";
  /** github owner/repo (+ optional #ref) or an absolute local dir */
  owner?: string;
  repo?: string;
  ref?: string;
  localPath?: string;
}

/** Parse an install spec:  github:owner/repo[#ref] | owner/repo | /abs/local/dir */
export function parseSpec(raw: string): ParsedSpec {
  const spec = raw.trim();
  if (!spec) throw new Error("empty plugin spec");
  // Local absolute path (a directory on disk).
  if (spec.startsWith("/") || spec.startsWith("~") || spec.startsWith(".")) {
    return { kind: "local", localPath: spec };
  }
  // github:owner/repo[#ref]  or  github.com URL  or bare owner/repo
  let s = spec;
  const m = s.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#]+)/i);
  if (m) {
    return { kind: "github", owner: m[1], repo: m[2].replace(/\.git$/, ""), ref: refOf(s) };
  }
  s = s.replace(/^github:/i, "");
  const [ownerRepo] = s.split("#");
  const parts = ownerRepo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`unrecognised plugin spec: "${raw}" (use github:owner/repo or a local path)`);
  }
  return { kind: "github", owner: parts[0], repo: parts[1].replace(/\.git$/, ""), ref: refOf(spec) };
}

function refOf(s: string): string | undefined {
  const i = s.indexOf("#");
  return i >= 0 ? s.slice(i + 1) : undefined;
}

/** Derive a stable, filesystem-safe plugin id from the spec. */
function idFor(spec: ParsedSpec): string {
  if (spec.kind === "local") return path.basename(spec.localPath!.replace(/\/+$/, "")).replace(/[^\w.-]/g, "-");
  return `${spec.repo}`.replace(/[^\w.-]/g, "-");
}

// ── Minimal tar (ustar) extractor ───────────────────────────────────────────
// Avoids a new runtime dependency. Handles the regular files + directories a
// GitHub codeload tarball contains (all entries share a top-level dir prefix
// we strip). Only the fields we need are parsed.
function untar(buf: Buffer, destDir: string, stripComponents = 1): void {
  let offset = 0;
  const readStr = (start: number, len: number) => {
    const slice = buf.subarray(start, start + len);
    const nul = slice.indexOf(0);
    return slice.toString("utf8", 0, nul === -1 ? len : nul).trim();
  };
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // Two consecutive zero blocks = end of archive.
    if (header.every((b) => b === 0)) break;
    const name = readStr(offset, 100);
    const sizeStr = readStr(offset + 124, 12);
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = String.fromCharCode(buf[offset + 156]);
    const prefix = readStr(offset + 345, 155);
    let full = prefix ? `${prefix}/${name}` : name;
    offset += 512;
    const dataStart = offset;
    offset += Math.ceil(size / 512) * 512; // advance past padded content

    if (!full) continue;
    // Strip the leading path components (codeload wraps everything in repo-ref/).
    const parts = full.split("/").slice(stripComponents);
    if (parts.length === 0) continue;
    full = parts.join("/");
    if (!full) continue;
    const outPath = path.join(destDir, full);
    // Contain: never escape destDir (defends against ../ in a crafted tar).
    if (!path.resolve(outPath).startsWith(path.resolve(destDir) + path.sep)) continue;

    if (typeFlag === "5") {
      fs.mkdirSync(outPath, { recursive: true });
    } else if (typeFlag === "0" || typeFlag === "" || typeFlag === "\0") {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buf.subarray(dataStart, dataStart + size));
    }
    // Other types (symlink/longname/etc.) are skipped — not expected here.
  }
}

async function fetchTarball(spec: ParsedSpec): Promise<Buffer> {
  const refs = spec.ref ? [spec.ref] : ["main", "master"];
  let lastErr: unknown;
  for (const ref of refs) {
    const url = `https://codeload.github.com/${spec.owner}/${spec.repo}/tar.gz/refs/heads/${ref}`;
    try {
      const res = await fetch(url);
      if (!res.ok) { lastErr = new Error(`GitHub returned ${res.status} for ${spec.owner}/${spec.repo}@${ref}`); continue; }
      const gz = Buffer.from(await res.arrayBuffer());
      return zlib.gunzipSync(gz);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`could not fetch ${spec.owner}/${spec.repo}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

interface DshPackageJson {
  main?: string;
  exports?: Record<string, unknown>;
  dsh?: { bundle?: { patch?: string }; client?: unknown };
}

/** Read package.json and resolve the backend + client entry files. */
function resolveEntries(pkgDir: string, id: string): { name: string | null; ui: string | null } {
  const pkgPath = path.join(pkgDir, "package.json");
  let pkg: DshPackageJson;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as DshPackageJson;
  } catch {
    throw new Error("package.json not found or invalid in the plugin package");
  }
  if (!pkg.dsh) throw new Error("not a dsh plugin (no \"dsh\" section in package.json)");

  const rel = (p: string) => `./${INSTALLED_DIR}/${id}/${p.replace(/^\.\//, "")}`;
  const exists = (p: string) => fs.existsSync(path.join(pkgDir, p.replace(/^\.\//, "")));

  // Backend: package "main" (the tool module). Only if it's shipped (built).
  let name: string | null = null;
  if (typeof pkg.main === "string" && exists(pkg.main)) name = rel(pkg.main);

  // UI: exports["./client"] (a dsh client plugin's UI half).
  let ui: string | null = null;
  const clientExport = pkg.exports?.["./client"];
  const clientPath = typeof clientExport === "string" ? clientExport
    : (clientExport && typeof clientExport === "object" ? ((clientExport as Record<string, string>).default ?? (clientExport as Record<string, string>).import) : undefined);
  if (typeof clientPath === "string" && exists(clientPath)) ui = rel(clientPath);

  if (!name && !ui) {
    throw new Error("no built entry found — the package ships neither main nor exports['./client'] (needs a build step, which install does not run)");
  }
  return { name, ui };
}

function readRows(root: string): Array<Record<string, unknown>> {
  try {
    const parsed = yaml.load(fs.readFileSync(path.join(root, MANIFEST), "utf8"), { schema: yaml.DEFAULT_SCHEMA });
    return Array.isArray(parsed) ? (parsed.filter((r) => r && typeof r === "object" && !Array.isArray(r)) as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/**
 * Make the app's own copies of the plugin's declared dependencies resolvable
 * from the extracted plugin directory: symlink each dependency/peerDependency
 * that the app ships into <pkgDir>/node_modules/<name>. Node resolves the
 * plugin's static `import "@deepseek-ai/dsh-tools"` by walking up from its file
 * and finds the symlink; the symlink's REAL path is inside the app's
 * node_modules, so the package's own transitive deps resolve there too.
 *
 * Unshipped deps are skipped (clearly logged) — the plugin's apply will fail on
 * them and surface a targeted error rather than an opaque resolve failure.
 */
function linkAppDependencies(pkgDir: string, id: string): void {
  let pkg: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  } catch {
    return;
  }
  const wanted = [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])];
  if (wanted.length === 0) return;
  const req = createRequire(__filename);
  let linked = 0;
  for (const name of wanted) {
    // Scoped names → nested dirs (node_modules/@deepseek-ai/x).
    const dest = path.join(pkgDir, "node_modules", name);
    if (fs.existsSync(dest)) continue;
    let src: string;
    try {
      src = path.dirname(req.resolve(`${name}/package.json`));
    } catch {
      console.warn(`[cairn-plugins] '${id}' depends on ${name}, which this app does not ship — its backend may fail to load`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(src, dest, "dir");
      linked++;
    } catch (err) {
      console.warn(`[cairn-plugins] '${id}' could not link ${name}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[cairn-plugins] '${id}' linked ${linked}/${wanted.length} app-provided dependencies into node_modules`);
}

function writeRows(root: string, rows: Array<Record<string, unknown>>): void {
  fs.writeFileSync(path.join(root, MANIFEST), yaml.dump(rows, { lineWidth: 100 }));
}

/** Install a plugin from a spec. Returns the resolved manifest entry. */
export async function installPlugin(rawSpec: string): Promise<InstallResult> {
  const root = getPluginsRoot();
  if (!root) throw new Error("no plugins directory configured");
  const spec = parseSpec(rawSpec);
  const id = idFor(spec);
  if (!id) throw new Error("could not derive a plugin id from the spec");

  const destDir = path.join(root, INSTALLED_DIR, id);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  if (spec.kind === "github") {
    const tar = await fetchTarball(spec);
    untar(tar, destDir, 1);
  } else {
    // Local: copy the directory tree as-is.
    const src = spec.localPath!.replace(/^~/, process.env.HOME ?? "~");
    if (!fs.existsSync(src)) throw new Error(`local path does not exist: ${src}`);
    fs.cpSync(src, destDir, { recursive: true });
  }

  const { name, ui } = resolveEntries(destDir, id);
  // Static-import resolution: the extracted plugin sits OUTSIDE any node_modules
  // tree, so its bare `import "@deepseek-ai/*"` calls can't resolve on their
  // own. Symlink the app's copies of its declared deps next to it.
  linkAppDependencies(destDir, id);

  // Upsert the manifest row (replace an existing entry with the same id).
  // `source` records the original spec so the row can be UPDATED later
  // (re-fetch github / re-copy local) without the user re-typing it. An
  // existing row's `disabled` state is preserved across a reinstall/update.
  const allRows = readRows(root);
  const prior = allRows.find((r) => r.id === id);
  const rows = allRows.filter((r) => r.id !== id);
  const row: Record<string, unknown> = { id };
  if (name) row.name = name;
  if (ui) row.ui = ui;
  row.source = rawSpec.trim();
  if (prior?.disabled === true) row.disabled = true;
  rows.push(row);
  writeRows(root, rows);

  const kind: InstallResult["kind"] = name && ui ? "both" : ui ? "ui" : "backend";
  return { id, name, ui, kind };
}

/**
 * Update an installed plugin by re-running its original install spec: a github
 * plugin re-fetches the latest tarball for its ref (default branch when none),
 * a local plugin re-copies from its source directory. The row's `source` is the
 * spec captured at install time. Throws when the id is unknown or was added by
 * hand (no recorded source to update from).
 */
export async function updatePlugin(id: string): Promise<InstallResult> {
  const root = getPluginsRoot();
  if (!root) throw new Error("no plugins directory configured");
  const existing = readRows(root).find((r) => r.id === id);
  if (!existing) throw new Error(`plugin "${id}" is not installed`);
  const source = typeof existing.source === "string" ? existing.source : undefined;
  if (!source) {
    throw new Error(`plugin "${id}" has no recorded source to update from (add it via Install to enable updates)`);
  }
  return installPlugin(source);
}


/** Uninstall: remove the manifest row and its extracted files. */
export function uninstallPlugin(id: string): void {
  const root = getPluginsRoot();
  if (!root) throw new Error("no plugins directory configured");
  const rows = readRows(root).filter((r) => r.id !== id);
  writeRows(root, rows);
  // Only remove files we own (installed/<id>). Hand-authored plugins are left be.
  const dir = path.join(root, INSTALLED_DIR, id);
  if (path.resolve(dir).startsWith(path.resolve(path.join(root, INSTALLED_DIR)) + path.sep)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
