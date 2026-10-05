/**
 * Codebase index views (Architecture tab) shared by the main-process queries
 * (`electron/db/codebase-queries.ts`), the typed IPC contract and the renderer.
 * Row fields keep their snake_case SQLite names.
 */

export interface CodebaseSymbol {
  id: string;
  file_id: string;
  name: string;
  kind: string;
  line: number;
  signature: string;
  docstring: string | null;
  file_path: string;
  root_path: string;
}

export interface CodebaseOverviewFile {
  id: string;
  file_path: string;
  root_path: string;
  indexed_at: string;
  symbol_count: number;
  relation_count: number;
}

export interface CodebaseOverview {
  folder: string;
  roots: string[];
  fileCount: number;
  totalSymbols: number;
  totalRelations: number;
  lastIndexedAt: string | null;
  kinds: Array<{ kind: string; count: number }>;
  files: CodebaseOverviewFile[];
}

export interface CodebaseRelationEdge {
  type: string;
  target_name: string;
  source_name: string;
  source_file: string;
}

export interface CodebaseRelations {
  incoming: CodebaseRelationEdge[];
  outgoing: CodebaseRelationEdge[];
}

export interface CodebaseGraphNode {
  id: string;
  file_path: string;
  root_path: string;
  symbol_count: number;
}

export interface CodebaseGraphEdge {
  source: string;
  target: string;
  weight: number;
}

/** File-level dependency graph. */
export interface CodebaseGraph {
  folder: string;
  nodes: CodebaseGraphNode[];
  edges: CodebaseGraphEdge[];
}

export interface CodebaseModuleNode {
  id: string;
  label: string;
  fileCount: number;
  symbolCount: number;
  internalRefs: number;
}

/** Files grouped into directory modules `depth` levels deep. */
export interface CodebaseModuleGraph {
  folder: string;
  depth: number;
  grouping: "directory";
  nodes: CodebaseModuleNode[];
  edges: CodebaseGraphEdge[];
}
