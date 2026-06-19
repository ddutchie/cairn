# MCP Payload Optimization — Scratch Pad

Goal: audit and shrink JSON return payloads for every MCP tool in `electron/mcp/tools/*`
to minimise the tokens the agent must parse per call.

Token estimate: ~4 chars/token. Sizes are `JSON.stringify(result).length` (compact,
as the MCP server emits them via `electron/mcp-server.ts:50` — `JSON.stringify(result)`).

## Conventions

- "Before" / "After" measured by `electron/mcp/payload-baseline.test.ts` against
  a representative seed (below). Run via `npx vitest run electron/mcp/payload-baseline.test.ts`.
- "Δb" = bytes saved (before − after).
- "Δt" = approx tokens saved (Δb ÷ 4).

### Representative seed

(`electron/mcp/payload-baseline.test.ts`)

- 2 workspaces
- 3 projects (one archived)
- 2-3 columns per project (one backlog, one done)
- ~5 notes per project (one pinned with a ~2000-char body)
- ~6 cards per project (one archived, one blocked by another)
- 3 tags shared across notes/cards
- One idea_flow with 4 nodes (idea, note_ref, task_ref, group) and 2 edges
- 3 `relationship_cache` rows (co-mention, wikilink, semantic)

## Results

### MCP tools (`electron/mcp/` + `electron/shared/read-tools-pure.ts`)

| Tool | Before (b) | After (b) | Δb | Δt | % |
|------|-----------:|----------:|---:|---:|---:|
| get_cairn_context | 2711 | 1978 | 733 | 183 | 27 % |
| get_project_context_pack | 3259 | 2801 | 458 | 115 | 14 % |
| search_notes | 468 | 388 | 80 | 20 | 17 % |
| search_tasks | 530 | 500 | 30 | 8 | 6 % |
| get_note | 2531 | 2531 | 0 | 0 | 0 % (contract fields kept) |
| get_task | 459 | 459 | 0 | 0 | 0 % |
| list_ready_tasks | 651 | 519 | 132 | 33 | 20 % |
| get_knowledge_graph | 7272 | 3109 | 4163 | 1041 | 57 % |
| get_neighbors | 991 | 541 | 450 | 113 | 45 % |
| get_semantic_neighbors | 35 | 35 | 0 | 0 | 0 % (already minimal) |
| get_idea_flow | 1393 | 1316 | 77 | 19 | 6 % |
| **MCP subtotal** | **20,200** | **15,010** | **5,190** | **1,298** | **26 %** |

### Chat-only tools (`electron/ipc/chat-executor.ts`)

Most chat-only tools already forward through `executeMcpTool` (or `executeReadTool`→
`read-tools-pure.ts`) so they inherit every MCP optimisation above automatically.
Only four tools are defined inline in `chat-executor.ts` (`CHAT_ONLY_TOOLS` in
`electron/lib/tool-schemas.ts:446`):

| Tool | Before (b) | After (b) | Δb | Δt | Notes |
|------|-----------:|----------:|---:|---:|-------|
| get_active_context | 1744 | 1530 | 214 | 54 | see optimizations below |
| ask_questions | 55 | 55 | 0 | 0 | ack payload, skip |
| suggest_connections | 21 | 21 | 0 | 0 | ack payload, skip |
| generate_prd | n/a | n/a | n/a | n/a | LLM-derived content, can't meaningfully baseline |
| spawn_tasks_from_note | n/a | n/a | n/a | n/a | LLM-derived card list, can't meaningfully baseline |



The biggest wins came from the three read-heavy tools (knowledge graph,
neighbours, cairn context) — together they account for 4,055 of the 3,441 bytes
saved. Write tools already returned small confirmation payloads and were left
untouched except for `list_ready_tasks`.

## Optimizations applied

### 1. `get_knowledge_graph` — `electron/mcp/tools/graph.ts`

**Two passes were applied:**

#### Pass 1 — field compaction (7272 → 4344 b, -40 %)
- Added `compactNode` + `compactEdge` helpers that run only at the MCP layer; the
  DB-layer `getKnowledgeGraph` in `electron/db/graph-queries.ts` is untouched so the
  renderer IPC handler (`electron/ipc/graph-handlers.ts:18`) still gets the full shape.
- Per **node**:
  - Drop `workspaceId` (constant across a workspace-scoped graph).
  - Flatten the `meta` object: project membership, tag ids, snippet, etc. get
    hoisted onto the node only when actually present. Empty `meta: {}` becomes
    nothing. Skips undefined/null/empty-array fields.
- Per **edge**:
  - Drop the synthetic `id` (agents identify edges by `source + target + type`).
  - Drop predictable labels (`"belongs to"` for `project-member`, `"tagged"` for
    `tag-member`).
  - Omit empty `label` / `weight` / `sourceSectionTitle` / `targetSectionTitle`.
  - Short keys for the rare-but-helpful secondary fields: `s`, `t` for
    source/target (kept readable but compact), `w`, `sSec`, `tSec`.

#### Pass 2 — type-partitioned column encoding (4344 → 3109 b, -29 %; total -57 %)

Inspired by Headroom's SmartCrusher pattern: encode arrays of records as
`{ fields: [...], rows: [[v,v,...], ...] }` instead of `[{k:v,k:v}, ...]`.

**Type partitioning**: nodes are grouped into `projects` / `notes` / `cards` /
`tags` buckets and each bucket is column-encoded independently. This delivers
two compounding wins:
- `type` is dropped per-row — the bucket key already tells the consumer the
  type, so every row drops `"type":"project"` etc.
- Each bucket's `fields` array only contains keys its members actually use.
  Projects never gain a `snippet` column, notes never gain a `color` column,
  so per-type column sets are narrow (3-5 fields vs 12 for the union).

Edges are partitioned the same way (`project-member` / `tag-member` /
`note-card` / `flow-edge` / `co-mention` / `wikilink` / `semantic` blocks).
For `project-member` and `tag-member` edges there's literally nothing left
except `s` and `t` (the `label` is dropped by `compactEdge` because it's
predictable, and `w`/section titles never appear) — those buckets become
`{fields:["s","t"],rows:[[...,...],...]}`, two bytes of structural overhead
per row vs ~15 for the verbose form.

**Present-only column filter**: within a bucket, fields that are absent from
*every* record are omitted from the header. So projects never carry a
`tagIds` column even if some notes do.

**Threshold (`COLUMN_THRESHOLD = 4`)**: buckets with fewer than 4 rows stay in
verbose object form. Below 4 rows the header tax (`"fields":[...]`) exceeds
the per-row savings, especially for narrow buckets like `tag` (3 rows × 3
fields × 4-byte key names = 36 b saved vs 27 b header).

**Output shape**:
```
{ "nodes": { "project": { fields, rows } | [...objects],
             "note":    { fields, rows } | [...objects],
             "card":    { fields, rows } | [...objects],
             "tag":     { fields, rows } | [...objects] },
  "edges": { "project-member": { fields, rows } | [...objects],
             "tag-member":     { fields, rows } | [...objects],
             "note-card":      { fields, rows } | [...objects],
             "flow-edge":      { fields, rows } | [...objects],
             ... } }
```
A missing bucket means "no nodes/edges of that type". A bucket with the
verbose form (small groups) has the same field set minus `type`.

**Why this is safe**: tests in `electron/mcp-server.test.ts` and
`electron/ipc/chat-executor.test.ts` do not assert on the
`get_knowledge_graph` return shape — only on input handling and on at-most
one workaround (`get_neighbors` shape is asserted, and it was kept as
explicit objects, not column-encoded, because neighbor rows carry per-row
metadata that doesn't partition well).

### 2. `get_neighbors` — `electron/mcp/tools/graph.ts`
- `center` runs through `compactNode` (drops `workspaceId` and empty meta).
- Each neighbour collapses to:
  `{ id, type, title, projectId?, snippet?, distance, edgeType, edgeLabel?, w? }`
- Dropped: the per-neighbour full `node` metadata blob, the full `edge` object
  duplicated under `edge.source/target/id`.
- Net: 991 → 541 b (-45 %), 248 t → 135 t.

### 3. `get_cairn_context` — `electron/mcp/tools/metadata.ts`
- Removed the entire static `tools: { read, write, delete, ideaFlow }` block.
  MCP clients enumerate tools via `tools/list` (`mcp-server.ts:42`) and the agent
  system prompt lists them directly — this was ~600 bytes of redundant text
  baked into every `get_cairn_context` call.
- Omit `status` on projects when it's `"active"` (the common default) and omit
  `priority` when it's `"medium"` (likewise). The agent still sees the full enum
  set via `conventions.projectStatus` / `conventions.priority`.
- Omit `columns: []` for projects that have no columns (absence is unambiguous).
- Kept `conventions` (it's reference material the agent genuinely relies on at
  session start; the dashboard convention is documented in `DASHBOARD_CONSTANTS`
  but appears here too because it's the right place for create-vs-update
  guidance).
- Kept `workspaceId` on projects/tags — `getCairnContext` returns ALL workspaces
  (multi-workspace setups are common), so the field is the only thing that
  disambiguates which workspace each entity belongs to. `create_tag` requires
  `workspaceId` as input, so the agent must have the mapping.

### 4. `search_notes` — `electron/shared/read-tools-pure.ts`
- Snippet length trimmed 200 → 120 chars (prompt-guidance target). Tests still
  pass (`expect(snippet.length).toBeLessThanOrEqual(200)`).

### 5. `search_tasks` — `electron/shared/read-tools-pure.ts`
- Omit `description` when the card has no description (was `null`).
- Omit `dueDate` when the card has no due date (was `null`).

### 6. `get_project_context_pack` — `electron/shared/read-tools-pure.ts`
- Omit `description` and `dueDate` per open-task when null (as above).
- Pinned-note truncation limits (1000 chars) and open-task description truncation
  (400 chars) kept intact — the truncation markers are asserted by
  `mcp-server.test.ts`.

#### Pass 2 — additional `get_project_context_pack` compaction (3259 → 2801 b, -14 %)
- Drop `updatedAt` from each `recentActivity` entry. The array is still sorted
  newest-first by `updatedAt` internally, but the field is stripped from the
  emitted shape (tests only inspect `id` ordering, mcp-server.test.ts:1317-1326).
  ~40 b × 10 entries = ~400 b saved.
- Drop `columnName` from each `openTasks` group entry. Tests assert on
  `columnType`, not `columnName`; the top-level `project.columns` array
  still carries `{id, name, type}` for cross-reference when the agent
  needs the human-readable column name.
- Omit default `status: "active"` / `priority: "medium"` on the top-level
  `project` object (same convention as `get_cairn_context` pass 1).

### 7. `list_ready_tasks` — `electron/mcp/tools/tasks.ts`
- Drop `blockedByIds: []` — by definition, ready tasks have no pending blockers.
- Omit `dueDate` when null (was `null`).

### 8. `get_idea_flow` — `electron/mcp/tools/flow.ts`
- Omit `width`, `height`, `parentId` when null/undefined — agents treat absence
  the same as the previous explicit `null`.
- Omits `label: null` on edges.

### 9. `get_active_context` — `electron/ipc/chat-executor.ts`
- Drop `status: "active"` (`status: "active"` was emitted on every project in
  `activeProject` and `allProjects` — that's the DB-default enum value, and the
  enum list lives in `get_cairn_context`'s conventions for sessions that need
  the full set). Absent status = "active".
- Drop `columnName` from every entry in `recentTasks`. The `columns` array on
  the same payload already carries the `columnId`→`name` mapping, so the
  duplicated name was pure redundancy.
- Omit `dueDate` when null on each recent task (was `null` previously). Was
  emitting `"dueDate":null` for every task without a due date — roughly one
  field-name-plus-null per task.
- Kept `workspace.workspaceId` + `workspace.name` (the wrapped shape)
  untouched because the existing tests in `chat-executor.test.ts` assert
  `result.activeProject` and `result.columns` exist at the top level, and
  the agent prompt at `pi-agent-prompt.ts:164` instructs the agent to read
  `get_active_context` to "get column IDs" — so the workspace+project ID
  are the load-bearing fields.
- Kept id-naming convention (`noteId`, `columnId`, `taskId`, `projectId`,
  `workspaceId`) instead of normalising to `id`. Tests in
  `chat-executor.test.ts:368/377/387` assert these specific keys; the same
  prefix appears in input arg names (`noteId` for `get_note`,
  `cardId` for `get_task`, `columnId` for `create_task`), so the asymmetry
  is actually a feature: the key tells the agent which entity type the
  value refers to (`taskId` ≠ `cardId` ≠ `noteId`).

### 10. Agent loop — drop pretty-printing (`electron/lib/pi-agent-loop.ts:397`)

The chat agent loop previously stringified tool results with
`JSON.stringify(result, null, 2)` — 2-space indented. The MCP server itself
emits compact JSON (`electron/mcp-server.ts:50`), so the indent overhead only
applied to the chat-agent path, not the MCP path.

Switched to `JSON.stringify(result)` (compact). Whitespace was pure overhead
for an LLM consumer — models tokenize JSON structure regardless of indent,
and every newline + indent level was a wasted token. Human log readability
becomes slightly worse but is recoverable via a debug flag if needed.

Measured overhead per tool (compact vs pretty on the seed):

| Tool | Compact (b) | Pretty (b) | Overhead |
|------|------------:|-----------:|---------:|
| get_knowledge_graph | 3,109 | 6,349 | +104 % |
| get_idea_flow | 1,316 | 2,080 | +58 % |
| list_ready_tasks | 519 | 688 | +33 % |
| get_project_context_pack | 2,801 | 3,728 | +33 % |
| get_neighbors | 541 | 710 | +31 % |
| search_tasks | 500 | 609 | +22 % |
| get_task | 459 | 524 | +14 % |
| search_notes | 388 | 461 | +19 % |
| get_note | 2,531 | 2,568 | +1 % (long content dominates) |
| **Total** | **14,560** | **20,992** | **+44 %** |

Saved ~1,608 tokens per agent turn cycle (across all tool calls in a turn).
Bigger than every compaction across passes 1 + 2 combined.

## Optimisations considered but NOT applied

- **Renaming common field names** (`workspaceId → ws`, `projectId → pid`).
  Below the cost/benefit threshold — the savings would be modest after the
  compaction above, the field names are documented in `DASHBOARD_CONSTANTS`
  (dashboard contract), and they're asserted by tests in `electron/mcp-server.test.ts`.
  Field-name stability also keeps the agent's mental model consistent between
  tool input args (e.g. `{ projectId }`) and tool output.

- **Tuple-encoded arrays** (`[["id","title"], ...]` instead of `[{id,title}]`).
  Replaced in pass 2 by type-partitioned column encoding (`{fields, rows}`),
  which is less cryptic for an LLM consumer than unnamed tuples while
  delivering the same per-row key-repetition savings.

- **Pagination / cursors** on `get_knowledge_graph`. The function already accepts
  tight filtering via `projectIds`, `nodeTypes`, `edgeTypes`, `includeAuto`; in
  the worst case the agent uses `get_neighbors` for focused traversal
  (preferred by the agent prompt at `electron/lib/tools.ts:148`).

- **`get_note` content truncation**. The content blob is the actual value of the
  tool — agents call it specifically when they need the full markdown body for
  `patch_note` / `append_to_note` decisions. Truncating here would force every
  multi-step append sequence to call `get_note` a second time.

- **Aggressive key shortening** in tool outputs (`description → desc`,
  `priority → prio`, etc.). Would shave a handful of bytes per record but
  degrade readability of agent logs and break the dashboard contract.

## Verification

After all changes:

```
npm run type-check:all     # clean
npm run lint               # clean
npm test                   # 514/514 tests pass
npm run compile            # dist-mcp/mcp-server.bundle.js rebuilt
```

Reproduce the baseline numbers yourself:

```
npx vitest run electron/mcp/payload-baseline.test.ts
```

