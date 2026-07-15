/**
 * Cairn — codebase semantic-indexing SQLite queries (files, symbols, relations,
 * overview + graph rollups for the Architecture / ModuleMap views and the
 * codebase MCP tools).
 *
 * Extracted from db/queries.ts to keep that file focused on the core app domain.
 * Re-exported from db/queries.ts (`export * from "./codebase-queries"`) so every
 * existing `../db/queries` / `./queries` import (lib/codebase-index.ts,
 * mcp/tools/codebase.ts, ipc/agent.ts, components/agent/ModuleMap.tsx) is
 * unchanged.
 *
 * Same governance as db/queries.ts: NEVER construct a Database here — these run
 * on the already-constructed handle passed in by the caller.
 */

import type Database from "better-sqlite3";
import * as path from "path";
import { ts } from "./utils";

// ── Codebase Semantic Indexing ─────────────────────────

export function getCodebaseFileByPath(db: Database.Database, filePath: string) {
  return db.prepare("SELECT * FROM codebase_files WHERE file_path = ?").get(filePath) as {
    id: string;
    root_path: string;
    file_path: string;
    hash: string;
    indexed_at: string;
  } | undefined;
}

export function upsertCodebaseFile(db: Database.Database, file: { id: string; rootPath: string; filePath: string; hash: string }) {
  const now = ts();
  db.prepare(`
    INSERT INTO codebase_files (id, root_path, file_path, hash, indexed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      hash = excluded.hash,
      indexed_at = excluded.indexed_at
  `).run(file.id, file.rootPath, file.filePath, file.hash, now);
  return db.prepare("SELECT * FROM codebase_files WHERE id = ?").get(file.id) as {
    id: string;
    root_path: string;
    file_path: string;
    hash: string;
    indexed_at: string;
  };
}

export function clearCodebaseFileData(db: Database.Database, fileId: string) {
  db.prepare("DELETE FROM codebase_symbols WHERE file_id = ?").run(fileId);
}

export function insertCodebaseSymbol(db: Database.Database, symbol: {
  id: string;
  fileId: string;
  name: string;
  kind: string;
  line: number;
  signature: string;
  docstring: string | null;
}) {
  db.prepare(`
    INSERT INTO codebase_symbols (id, file_id, name, kind, line, signature, docstring)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(symbol.id, symbol.fileId, symbol.name, symbol.kind, symbol.line, symbol.signature, symbol.docstring);
}

export function insertCodebaseRelation(db: Database.Database, relation: {
  sourceId: string;
  targetName: string;
  type: string;
}) {
  db.prepare(`
    INSERT OR IGNORE INTO codebase_relations (source_id, target_name, type)
    VALUES (?, ?, ?)
  `).run(relation.sourceId, relation.targetName, relation.type);
}

/**
 * Build the SQL fragment + params that scope a codebase query to `folder` (an
 * exact root/file match, or any file under it). The subtree match uses SQL LIKE,
 * so any LIKE metacharacters (`%`, `_`, and the `\` escape char) in the folder
 * path are escaped and an explicit `ESCAPE '\'` clause is emitted — otherwise a
 * path containing e.g. `_` would match sibling folders too. Assumes the caller
 * aliases the files table as `f`. Shared by every codebase read query.
 */
function codebaseScope(folder: string): { sql: string; params: string[] } {
  const normalized = path.resolve(folder);
  const escaped = normalized.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return {
    sql: `(f.root_path = ? OR f.file_path = ? OR f.file_path LIKE ? ESCAPE '\\')`,
    params: [normalized, normalized, `${escaped}${path.sep}%`],
  };
}

export function searchCodebaseSymbols(db: Database.Database, opts: { query: string; folder?: string; limit?: number }) {
  const q = opts.query.toLowerCase();
  const limit = opts.limit ?? 50;
  
  let sql = `
    SELECT s.*, f.file_path, f.root_path
    FROM codebase_symbols s
    JOIN codebase_files f ON s.file_id = f.id
    WHERE (lower(s.name) LIKE ? OR lower(s.signature) LIKE ? OR lower(s.docstring) LIKE ?)
  `;
  const params: unknown[] = [`%${q}%`, `%${q}%`, `%${q}%`];
  
  if (opts.folder) {
    const scope = codebaseScope(opts.folder);
    sql += ` AND ${scope.sql}`;
    params.push(...scope.params);
  }
  
  sql += ` ORDER BY s.name LIMIT ?`;
  params.push(limit);
  
  return db.prepare(sql).all(...params) as Array<{
    id: string;
    file_id: string;
    name: string;
    kind: string;
    line: number;
    signature: string;
    docstring: string | null;
    file_path: string;
    root_path: string;
  }>;
}

export function getCodebaseSymbolDefinition(db: Database.Database, name: string, folder?: string) {
  let sql = `
    SELECT s.*, f.file_path, f.root_path
    FROM codebase_symbols s
    JOIN codebase_files f ON s.file_id = f.id
    WHERE s.name = ?
  `;
  const params: unknown[] = [name];
  
  if (folder) {
    const scope = codebaseScope(folder);
    sql += ` AND ${scope.sql}`;
    params.push(...scope.params);
  }
  
  return db.prepare(sql).all(...params) as Array<{
    id: string;
    file_id: string;
    name: string;
    kind: string;
    line: number;
    signature: string;
    docstring: string | null;
    file_path: string;
    root_path: string;
  }>;
}

export function getCodebaseRelations(db: Database.Database, name: string, folder?: string) {
  let sql1 = `
    SELECT r.type, r.target_name, s.name as source_name, f.file_path as source_file
    FROM codebase_relations r
    JOIN codebase_symbols s ON r.source_id = s.id
    JOIN codebase_files f ON s.file_id = f.id
    WHERE s.name = ?
  `;
  const params1: unknown[] = [name];
  if (folder) {
    const scope = codebaseScope(folder);
    sql1 += ` AND ${scope.sql}`;
    params1.push(...scope.params);
  }
  const outgoing = db.prepare(sql1).all(...params1) as Array<{
    type: string;
    target_name: string;
    source_name: string;
    source_file: string;
  }>;

  let sql2 = `
    SELECT r.type, r.target_name, s.name as source_name, f.file_path as source_file
    FROM codebase_relations r
    JOIN codebase_symbols s ON r.source_id = s.id
    JOIN codebase_files f ON s.file_id = f.id
    WHERE r.target_name = ?
  `;
  const params2: unknown[] = [name];
  if (folder) {
    const scope = codebaseScope(folder);
    sql2 += ` AND ${scope.sql}`;
    params2.push(...scope.params);
  }
  const incoming = db.prepare(sql2).all(...params2) as Array<{
    type: string;
    target_name: string;
    source_name: string;
    source_file: string;
  }>;

  return { incoming, outgoing };
}

export function getCodebaseFileSymbols(db: Database.Database, filePath: string) {
  return db.prepare(`
    SELECT s.*, f.file_path, f.root_path
    FROM codebase_symbols s
    JOIN codebase_files f ON s.file_id = f.id
    WHERE f.file_path = ?
    ORDER BY s.line
  `).all(filePath) as Array<{
    id: string;
    file_id: string;
    name: string;
    kind: string;
    line: number;
    signature: string;
    docstring: string | null;
    file_path: string;
    root_path: string;
  }>;
}

export function deleteCodebaseRoot(db: Database.Database, rootPath: string) {
  db.prepare("DELETE FROM codebase_files WHERE root_path = ?").run(rootPath);
}

export function getCodebaseFilesByRoot(db: Database.Database, rootPath: string) {
  return db.prepare("SELECT * FROM codebase_files WHERE root_path = ?").all(rootPath) as Array<{
    id: string;
    root_path: string;
    file_path: string;
    hash: string;
    indexed_at: string;
  }>;
}

export function deleteCodebaseFile(db: Database.Database, fileId: string) {
  db.prepare("DELETE FROM codebase_files WHERE id = ?").run(fileId);
}

/**
 * Aggregate view of the codebase index for a given root folder — powers the
 * human-facing Architecture tab. Returns the indexed files (with per-file
 * symbol counts + relation edge counts), a symbol-kind breakdown, and headline
 * totals. `folder` matches a file's `root_path` OR any file under it, so an
 * indexed sub-tree is picked up regardless of the exact root string. All reads
 * hit the already-constructed db handle (no new Database).
 */
export function getCodebaseOverview(db: Database.Database, folder: string) {
  const normalized = path.resolve(folder);
  const { sql: scope, params: scopeParams } = codebaseScope(folder);

  const files = db.prepare(`
    SELECT
      f.id,
      f.file_path,
      f.root_path,
      f.indexed_at,
      (SELECT COUNT(*) FROM codebase_symbols s WHERE s.file_id = f.id) AS symbol_count,
      (SELECT COUNT(*) FROM codebase_relations r
         JOIN codebase_symbols s2 ON r.source_id = s2.id
        WHERE s2.file_id = f.id) AS relation_count
    FROM codebase_files f
    WHERE ${scope}
    ORDER BY f.file_path
  `).all(...scopeParams) as Array<{
    id: string;
    file_path: string;
    root_path: string;
    indexed_at: string;
    symbol_count: number;
    relation_count: number;
  }>;

  const kinds = db.prepare(`
    SELECT s.kind, COUNT(*) AS count
    FROM codebase_symbols s
    JOIN codebase_files f ON s.file_id = f.id
    WHERE ${scope}
    GROUP BY s.kind
    ORDER BY count DESC
  `).all(...scopeParams) as Array<{ kind: string; count: number }>;

  const totalSymbols = kinds.reduce((sum, k) => sum + k.count, 0);
  const totalRelations = files.reduce((sum, fl) => sum + fl.relation_count, 0);
  const roots = Array.from(new Set(files.map((fl) => fl.root_path)));
  const lastIndexedAt = files.reduce<string | null>(
    (max, fl) => (max == null || fl.indexed_at > max ? fl.indexed_at : max),
    null,
  );

  return {
    folder: normalized,
    roots,
    fileCount: files.length,
    totalSymbols,
    totalRelations,
    lastIndexedAt,
    kinds,
    files,
  };
}

/**
 * File-level dependency graph for the Architecture graph view. Resolves each
 * call/reference edge (source symbol → target symbol name) to the files that
 * define them, then aggregates a weighted, directed file→file edge (self-loops
 * within a file are dropped). Also returns the file nodes (with symbol counts)
 * so the renderer can lay out a module-dependency diagram, plus a lightweight
 * per-file symbol list for expand-in-place. Scoped like getCodebaseOverview.
 */
export function getCodebaseGraph(db: Database.Database, folder: string) {
  const normalized = path.resolve(folder);
  const { sql: scope, params: scopeParams } = codebaseScope(folder);

  const nodes = db.prepare(`
    SELECT
      f.id,
      f.file_path,
      f.root_path,
      (SELECT COUNT(*) FROM codebase_symbols s WHERE s.file_id = f.id) AS symbol_count
    FROM codebase_files f
    WHERE ${scope}
    ORDER BY f.file_path
  `).all(...scopeParams) as Array<{
    id: string; file_path: string; root_path: string; symbol_count: number;
  }>;

  // Directed, weighted file→file edges. A relation's source symbol lives in one
  // file (sf); its target NAME is resolved to the file that defines it (tf). To
  // avoid the graph exploding with false edges, we ONLY link target names that
  // are UNAMBIGUOUS — defined in exactly one file within scope. A name defined
  // in many files (e.g. `dispose`, `makeDb`) can't be attributed to a single
  // file, so linking it to all of them is noise; we drop those. Self-references
  // are excluded. Both endpoints must be in scope.
  const edges = db.prepare(`
    WITH scoped_syms AS (
      SELECT s.id, s.name, s.file_id
      FROM codebase_symbols s
      JOIN codebase_files f ON s.file_id = f.id
      WHERE ${scope}
    ),
    unambiguous AS (
      SELECT name FROM scoped_syms GROUP BY name HAVING COUNT(DISTINCT file_id) = 1
    )
    SELECT sf.id AS source, ts.file_id AS target, COUNT(*) AS weight
    FROM codebase_relations r
    JOIN scoped_syms ss ON r.source_id = ss.id
    JOIN codebase_files sf ON ss.file_id = sf.id
    JOIN scoped_syms ts ON ts.name = r.target_name
    WHERE r.target_name IN (SELECT name FROM unambiguous)
      AND ss.file_id != ts.file_id
    GROUP BY sf.id, ts.file_id
  `).all(...scopeParams) as Array<{
    source: string; target: string; weight: number;
  }>;

  return { folder: normalized, nodes, edges };
}

/**
 * Directory-aggregated MODULE graph for the Architecture overview (module map).
 * Rolls the de-noised file→file dependency graph up to "modules" — directory
 * paths truncated to `depth` segments (relative to the scoped root) — and
 * aggregates weighted inter-module edges (intra-module edges are dropped; they
 * become the module's internal cohesion count instead). Module size is the
 * total symbol count of its files.
 *
 * Grouping is done in JS (not SQL) so the strategy stays pluggable: today it's
 * directory-based; a future import-clustering strategy can slot in here without
 * touching the renderer. Reuses getCodebaseGraph for the (already unambiguous,
 * call-syntax-only) file edges.
 */
export function getCodebaseModuleGraph(
  db: Database.Database,
  folder: string,
  depth = 1,
) {
  const { folder: normalized, nodes: files, edges: fileEdges } = getCodebaseGraph(db, folder);
  const d = Math.max(1, Math.floor(depth));

  // Map a file → its module id (directory truncated to `depth` segments).
  const moduleOf = (filePath: string): string => {
    let rel = filePath;
    if (normalized && filePath.startsWith(normalized)) {
      rel = filePath.slice(normalized.length).replace(/^[/\\]/, "");
    }
    const parts = rel.split(/[/\\]/);
    if (parts.length <= 1) return "(root)";
    return parts.slice(0, -1).slice(0, d).join("/") || "(root)";
  };

  // Build module nodes: aggregate symbol + file counts.
  const modules = new Map<string, { id: string; label: string; fileCount: number; symbolCount: number; internalRefs: number }>();
  const fileModule = new Map<string, string>();
  for (const f of files) {
    const m = moduleOf(f.file_path);
    fileModule.set(f.id, m);
    const node = modules.get(m) ?? { id: m, label: m, fileCount: 0, symbolCount: 0, internalRefs: 0 };
    node.fileCount += 1;
    node.symbolCount += f.symbol_count;
    modules.set(m, node);
  }

  // Aggregate inter-module edges; count intra-module edges as cohesion.
  const edgeMap = new Map<string, { source: string; target: string; weight: number }>();
  for (const e of fileEdges) {
    const sm = fileModule.get(e.source), tm = fileModule.get(e.target);
    if (sm == null || tm == null) continue;
    if (sm === tm) {
      const node = modules.get(sm);
      if (node) node.internalRefs += e.weight;
      continue;
    }
    const key = `${sm}\u0000${tm}`;
    const agg = edgeMap.get(key) ?? { source: sm, target: tm, weight: 0 };
    agg.weight += e.weight;
    edgeMap.set(key, agg);
  }

  return {
    folder: normalized,
    depth: d,
    grouping: "directory" as const,
    nodes: Array.from(modules.values()).sort((a, b) => a.id.localeCompare(b.id)),
    edges: Array.from(edgeMap.values()),
  };
}

