## Cleanup (P1 — SQL Consolidation across the Electron↔MCP boundary)

Architectural-deep-dive cleanup (see `docs/cleanup/`). Phase P1 eliminates the
~1000 lines of SQL duplicated between the Electron main process (`electron/db/queries.ts`
+ `electron/db/graph-queries.ts`) and the MCP server (`electron/mcp/tools/*` + `mcp/db.ts`).
This is unblocked by P0-5, which corrected the stale AGENTS.md claim that an "ABI boundary"
prevented importing `queries.ts` from the MCP runtime.

### Why this was safe

The only ABI-sensitive operation in `better-sqlite3` is constructing the `Database`
instance — that happens once in `electron/mcp-server.ts:140`
(`new Database(dbPath, { nativeBinding: MCP_NATIVE_BINDING })`). All `db.prepare(...).run(...)`
calls execute on that already-constructed handle regardless of which TS file defines them.
`electron/mcp/tools/codebase.ts` already imported `* as q from "../../db/queries"` and
worked in the bundle — P1 extends that pattern to the other 6 tool files.

### Consolidated files (in migration order)

Every MCP tool file now delegates to the canonical `q.*` (or `getKnowledgeGraph` /
`getNeighbours` from `graph-queries.ts`) helpers. Each migration preserved the public MCP
tool signatures and return shapes; only the implementation changed. All 103 MCP server
tests pass unchanged.

| File | Before | After | Net | What was removed |
|------|-------:|------:|----:|------------------|
| `mcp/tools/tags.ts` | 14 | 18 | +4 | Wrapped `q.createTag`; tiny file got slightly longer because of arg-validation boilerplate |
| `mcp/tools/projects.ts` | 70 | 55 | −15 | Inline INSERT/UPDATE/DELETE + the 4-statement cascade → `q.createProject` / `q.updateProject` / `q.deleteProject` (+ `q.createColumn` for default columns) |
| `mcp/tools/dashboards.ts` | 30 | 31 | +1 | INSERT note with `type='dashboard'` → `q.createNote` / `q.updateNote` with `type: "dashboard"` |
| `mcp/tools/notes.ts` | 187 | 213 | +26 | UPDATE-then-write-file flow kept (MCP-specific file-sync); SQL replaced with `q.updateNote` / `q.createNote` / `q.getNoteById` / `q.deleteNote`. Slight growth from passing patch objects explicitly. The `lockNote`/`unlockNote`/`getNoteVersion` MCP-active-write helpers stay in `mcp/db.ts` (genuinely MCP-only behaviour). |
| `mcp/tools/tasks.ts` | 321 | 230 | −91 | 28 `db.prepare` calls collapsed: `q.createCard`, `q.updateCard`, `q.deleteCard`, `q.restoreCard`, `q.clearCardDueDate`, `q.addCardBlocker`, `q.removeCardBlocker`, `q.clearBlockersFromAll`, `q.getReadyCards`, `q.getCardById`. `list_ready_tasks` now wraps `q.getReadyCards` and only adds `columnName` from the snapshot (a one-line lookup). |
| `mcp/tools/flow.ts` | 313 | 290 | −23 | The 100-line `get_idea_flow` (a duplicate of `q.getResolvedFlow`'s 84-line BFS) now delegates to it and only maps the return shape (`node.position = {x,y}`, `resolved*` fields nested in `data`). Node/edge CRUD uses `q.createFlowNode` / `q.updateFlowNode` / `q.deleteFlowNode` / `q.createFlowEdge` / `q.deleteFlowEdge` (the `INSERT OR IGNORE` dedup is already in `q.createFlowEdge`). `layout_idea_flow` keeps its dagre logic (no equivalent in queries.ts). |
| `mcp/tools/graph.ts` | 183 | 39 | **−144** | The big one. `get_knowledge_graph` (114 LOC, 12 prepare calls, same project→notes→cards→tags→flow→relationship_cache algorithm as `getKnowledgeGraph`'s 312 LOC in `graph-queries.ts`) now delegates and only adapts the filter shape. `get_neighbors` (69 LOC, same BFS as `getNeighbours`) now delegates directly — same return shape. The algorithm is no longer maintained in two places. |
| `mcp/db.ts` | 212 | 199 | −13 | `getSnapshot` now delegates to `q.getFullSnapshot`. The `Snapshot.tags` element type is aliased to `ReturnType<typeof toTag>` (the 4-field shape `{id, workspaceId, name, color}` was already what `toTag` returns; the local redefinition is gone). MCP-active-write helpers (`lockNote`/`unlockNote`/`getNoteVersion`/`getCardVersion`/`resolveTagNames`/`insertNotification`/`ensureMcpActiveWritesTable`) stay — they implement genuinely MCP-only behaviour (locking + best-effort notifications on the MCP runtime). |

### Codebase-wide impact

- **Net LOC change in `electron/mcp/`:** −216 lines. (The few files that grew slightly did so
  because passing typed patch objects is more verbose than inlining SQL — but the SQL
  surface area and behavioural drift surface both shrank dramatically.)
- **Total `db.prepare()` calls eliminated:** ~80 (84 in `mcp/tools/*.ts` + 6 in `mcp/db.ts`
  via the snapshot consolidation; offset by ~6 added for the MCP-side existence checks the
  helpers don't cover).
- **Single source of truth:** the canonical graph algorithm (`getKnowledgeGraph` + BFS in
  `getNeighbours`) and the canonical flow-resolution algorithm (`getResolvedFlow`) and
  the canonical snapshot shape are each now defined once. The previous situation meant a
  fix to either algorithm had to be manually mirrored across the ABI boundary.
- **`electron/db/queries.ts`** now has a governance header documenting that it is the
  single source of truth for all SQL, may be imported from `mcp/tools/*` (precedent:
  `codebase.ts`), and that `Database` instances must never be constructed here.
- **`mcp/db.ts`** still re-exports `j`/`j2`/`p`/`b`/`newId`/`ts`/`toWorkspace`/`toProject`/
  `toNote`/`toColumn`/`toCard`/`toTag`/`writeNoteFile`/`deleteNoteFile`/etc. for the
  remaining MCP-specific code; these are unchanged.

### Behaviour preservation

- All 103 `electron/mcp-server.test.ts` tests pass unchanged (they exercise every MCP tool
  end-to-end against a real in-memory SQLite DB).
- All 22 `electron/db/queries.test.ts` tests pass (they exercise the query helpers
  directly).
- The MCP public API (tool names, argument shapes, return shapes) is unchanged — only the
  implementations behind those tools were consolidated.

### Follow-ups tracked in `docs/cleanup/findings.md`

These are out of scope for P1 but worth noting:

- `mcp/db.ts:getCardVersion` and `getNoteVersion` query the `version` column directly.
  They could move to queries.ts as `q.getCardVersion`/`q.getNoteVersion` if the Electron
  main process ever needs them (currently it doesn't — IPC handlers use optimistic UI
  merge instead).
- `mcp/db.ts:resolveTagNames` is MCP-only today but could move to queries.ts if needed
  elsewhere.
- The MCP-side existence checks in `flow.ts` (`getNodeFlowId`, the `SELECT 1 FROM
  idea_flow_nodes WHERE id = ?` lookups) could be replaced by
  `q.getFlowNodeById`/`q.getFlowEdgeById` helpers added to queries.ts. Left for now —
  keeping API surface small.

## Verification

- `npm run type-check:all` — clean (renderer + electron).
- `npm run lint -- --max-warnings 0` — clean.
- `npm run compile` — clean (esbuild bundles; the `* as q` import resolves to the inlined
  queries.ts module, exactly as it already did in `codebase.ts`).
- `npm test` — **430 tests pass across 18 files** (incl. 103 MCP server tests + 22
  queries tests).
- `npm run smoke-test` — 4/4 checks pass (verifies the compiled bundles load and native
  modules resolve).
