# Cairn Mobile App — Viability Exploration & Plan

Status: Draft / exploration
Owner: —
Date: 2026-07-02
Related: `docs/architecture-review.md`, `electron/db/schema.ts`, `electron/shared/notes-io.ts`, `electron/file-watcher.ts`, `electron/db/queries.ts`

---

## 1. Goal & confirmed requirements

Ship a **standalone, offline-first** mobile app (iOS + Android) for Cairn, built in **Expo**,
that maintains **one shared codebase brain** with the desktop app.

Confirmed with product owner:

- **Standalone app.** NOT a remote control of the desktop. It must work with the desktop app closed.
- **Offline-first.** The app has its **own local database** and syncs bidirectionally with the desktop workspace.
- **MVP UI scope:** Notes (read + edit), Board (view + move cards), Search, Chat. Plus a **lightweight Knowledge Graph** view. Explicitly **out**: Idea Flow, Insights, full desktop Knowledge Graph.
- **Sync transport: synced-folder oplog** (no backend, local-first). *(decided)*
- **Scope: 2 personal devices** — single user, no multi-user concurrency. Simplifies the conflict model. *(decided)*
- **Chat is online-only** via a **pluggable AI provider** (first-party Rork toolkit, or an OpenAI-compatible endpoint for self-builds — see §4a). Chat is the one feature that degrades when offline. *(decided)*

This is the harder of the two architectures considered in the earlier draft. Choosing
standalone + offline means **we are committing to building a real sync engine**, because we
now have two independently-writable databases that must reconcile without data loss.

---

## 2. The core challenge: sync, not UI

The UI rebuild in Expo is bounded, well-understood work. The **risk and cost concentrate in
the sync engine**. The codebase research below establishes exactly what the current data
model gives us for free and what we must add.

### What we get for free (sync-friendly facts)

| Fact | Why it helps | Source |
|---|---|---|
| **All IDs are client-generated `nanoid(12)`** (~71 bits) | Two devices can create rows offline with negligible collision risk. The hardest part of distributed creation is *already solved*. | `electron/db/utils.ts:6,9-11` |
| **Notes already dual-write to `.md` files** | Notes have a portable, mergeable text representation independent of the binary DB. | `electron/shared/notes-io.ts:179` |
| **A working FS→DB reconciler already exists** | The chokidar file-watcher already imports external `.md` edits into the DB with echo-suppression — a partial sync precedent. | `electron/file-watcher.ts` |
| **`updated_at` is set on every write** for most tables (via `ts()`) | A "changed since X" watermark is partially buildable today; indexes `idx_notes_updated_at` / `idx_cards_updated_at` exist. | `electron/db/utils.ts:14`, `schema.ts:163,165` |
| **`version` counters exist on `notes` + `task_cards`** | A starting point for optimistic concurrency / conflict detection. | `schema.ts:308,317` |

### What is missing and MUST be added (the actual project)

| Gap | Consequence if ignored | Required addition |
|---|---|---|
| **No tombstones. Deletes are hard-deletes** (except `archived_at` soft-archive on workspaces/projects/notes/cards) | A diff-based sync **cannot tell "deleted on peer A" from "not-yet-created on peer B"** → deleted items resurrect. `board_columns`, `tags`, `chat_*`, and all idea-flow tables have no soft-delete at all. | `deleted_at`/tombstone rows on every syncable table. | `schema.ts` (see §6) |
| **No changelog / oplog. `db:changed` is a zero-payload signal** ("something changed", re-hydrate everything) | No way to ask "what changed and how" — can't build incremental sync. | A changelog table (entity, op, logical clock, hash) populated by a write-wrapper or triggers. | `registry.ts:83-89` |
| **`tags` has NO timestamps at all** | Tag create/rename/recolor/delete is invisible to any timestamp diff. | Add `created_at`, `updated_at`, `version`, `deleted_at` to `tags`. | `schema.ts:93-98` |
| **`version` is advisory, not enforced** — the renderer write path never checks it; only some MCP tools do, and they return a soft error, never a hard reject | Cannot rely on it as a compare-and-swap gate. | Promote to real CAS (`WHERE id=? AND version=?`) on the write path, or adopt HLC. | `queries.ts:215,357`; `mcp/tools/notes.ts:126-131` |
| **Timestamps mix trusted (`ts()`) and untrusted (frontmatter `updatedAt`, file mtime) sources; cross-device clock skew** | Pure wall-clock watermarks corrupt under skew. | **Hybrid Logical Clocks (HLC)** or Lamport timestamps instead of trusting ISO strings. | `notes-files.ts:292`; `notes-io.ts:125-135` |
| **Existing note reconciliation is last-writer-wins by timestamp, whole-record, no field merge, no conflict record** | Concurrent edits silently lose one side. | A defined conflict policy + conflict surfacing (see §5). | `notes-files.ts:119-135` |

**Bottom line:** the transport and the collision-free ID scheme are reusable. The
replication protocol (changelog + tombstones + logical clock + CAS + conflict policy) is
net-new and is the crux of the project.

---

## 3. Recommended architecture

**One shared TypeScript core, two thin UI shells, and a sync layer that both DBs speak.**

```
                 ┌───────────────────────────────────────────┐
                 │        @cairn/core  (shared package)        │
                 │  domain types · zod schemas · store logic   │
                 │  sync protocol (changelog, HLC, tombstones, │
                 │  conflict resolution) · repository interface│
                 └───────────────┬───────────────┬─────────────┘
                                 │               │
        ┌────────────────────────▼──┐      ┌─────▼───────────────────────┐
        │ Desktop (Electron)         │      │ Mobile (Expo / React Native)│
        │  renderer UI (existing)    │      │  RN UI (new, MVP scope)     │
        │  better-sqlite3 cairn.db   │      │  expo-sqlite local DB       │
        └────────────┬───────────────┘      └─────────────┬───────────────┘
                     │                                     │
                     └──────────────  SYNC  ───────────────┘
                        (changelog exchange + reconcile)
```

Both databases run the **same schema + migrations** (so rows are structurally
interchangeable) and both implement the **same sync protocol** from `@cairn/core`. The
desktop's existing `.md` dual-write and file-watcher continue to work unchanged; the sync
engine operates at the DB/changelog layer, above them.

### Sync transport — DECIDED: synced-folder oplog
Standalone + offline needs a rendezvous point for two DBs to exchange changes. **Decision:
each device writes its oplog (+ note `.md` files) to a cloud-synced folder** (iCloud Drive /
Dropbox / Syncthing); the other device replays the peer's oplog on next launch/foreground.

- **Never sync `cairn.db` itself** — a binary SQLite file + WAL through opaque cloud merge =
  corruption/data loss. Only the append-only oplog files and `.md` files transit the synced folder.
- No backend to operate; keeps Cairn local-first.
- Because oplog files are **append-only and per-device** (`oplog-<deviceId>.ndjson` or chunked),
  the cloud sync only ever creates or grows distinct files — it never has to merge the same file
  from two writers, which is exactly the case cloud file-sync handles safely.
- The protocol is transport-agnostic (§4), so a LAN P2P or hosted relay path can be added later
  behind the same interface without reworking the reconcile logic.

Rejected alternatives: syncing the binary DB (corruption), LAN-only P2P (fails the offline/
desktop-closed requirement), hosted relay (needs a server; unnecessary for 2 personal devices).

---

## 4. Sync protocol design (the heart of the work)

Principles: **offline-first, convergent, delete-safe, skew-safe.**

> **Scope simplification (2 personal devices, single user):** there is no multi-user contention.
> Conflicts only arise when *the same person* edits the same item on both devices while offline.
> This is rare and low-stakes, so a **last-writer-wins + conflict-copy** policy is sufficient — we
> do NOT need CRDTs or three-way text merge. The protocol below is still fully convergent.

1. **Hybrid Logical Clock (HLC)** per device. Every mutation stamps an HLC value. HLC gives a
   total order that respects causality and tolerates clock skew — replacing today's fragile
   wall-clock ISO comparison.
2. **Append-only changelog / oplog** per device: `(entity_type, entity_id, op[insert|update|delete],
   hlc, field_values_or_delta, origin_device)`. Populated by a single write-wrapper around all
   mutations (the renderer already funnels through `queries.ts` and `db-handlers.ts`, so there
   is one choke point to instrument).
3. **Tombstones** for deletes on every syncable table, so deletion propagates and rows don't
   resurrect. Reuse existing `archived_at` where present; add `deleted_at` elsewhere.
4. **Sync = exchange oplogs since last-seen HLC watermark per peer, then replay in HLC order.**
   Convergent by construction (all peers replay the same ops in the same order).
5. **Conflict resolution policy (per entity type):**
   - Scalar fields (title, priority, column, etc.): **last-writer-wins by HLC**.
   - **Note body**: text is the high-risk field. Prefer **field-level LWW** for MVP, with a
     **conflict copy** (`<note> (conflicted copy, <device>, <time>)`) when both sides changed
     the body since the common ancestor — never silently discard. (Three-way text merge is a
     stretch goal.)
   - JSON-array fields (`tag_ids`, `linked_note_ids`, `blocked_by_ids`): **set-union/merge**
     rather than LWW, so concurrent tag/link additions both survive.
   - `board_columns` order: LWW on `order` is acceptable (cosmetic).
6. **Idempotent replay**: applying the same op twice is a no-op (guarded by HLC watermark +
   op identity), so partial/repeated syncs are safe.

### Scope note on chat & idea-flow
Chat messages are append-only (no `updated_at`). Chat is **online-only** (see §5.1), so mobile
chat threads/messages are created locally and synced create-only by `created_at`/HLC — no edit
conflicts possible. Idea-flow is **out of MVP** and can be excluded from the mobile DB entirely
at first; include its tables in the protocol later.

---

## 4a. Chat integration (online-only) — pluggable AI provider

Mobile chat does **not** use a local model; it calls a hosted model over HTTP and is
gracefully disabled/queued when offline. The backend is a **pluggable provider**
(`mobile/src/chat/providers/`) chosen automatically at runtime:

- **Rork toolkit** (first-party builds) — `POST {base}/agent/chat` (SSE, Vercel AI
  UI-message-stream v1) with native tool-calling:
  `{ id, messages: [{ id, role, parts: [...] }], tools, stream: true, trigger: "submit-message" }`.
  Messages use the AI SDK v5 `UIMessage` shape (`parts[]` + per-message `id`); a plain
  `{role,content}` body 500s. Implemented in `providers/rork.ts`.
  **Security:** the Rork endpoint is **unauthenticated**, so its URL is NOT hardcoded in
  source and has no default. It is read only from the `EXPO_PUBLIC_TOOLKIT_URL` build-time
  env var (kept in git-ignored `.env.local`). If unset, this provider is unavailable and the
  app falls back to OpenAI. *(A leaked URL would let anyone run up our server bill; env only
  keeps it out of git — `EXPO_PUBLIC_*` is still inlined into a first-party binary, so a fully
  abuse-proof setup needs an authenticated proxy, tracked separately.)*
- **OpenAI-compatible** (default for third-party / self-builds) — `POST {base}/chat/completions`
  with `Authorization: Bearer <key>`, standard `messages[]` + `tools[]` function schemas,
  SSE `chat.completion.chunk` deltas. Implemented in `providers/openai.ts`, which maps our
  `UIMessage`/tool shapes to OpenAI's and translates chunks back to the shared `StreamEvent`.
  Config (base URL, model, API key) is set in-app: base URL/model in the local `app_settings`
  table, **API key in the device keychain** (`expo-secure-store`) — never in the DB, never synced.
  Works with OpenAI, Azure OpenAI, OpenRouter, Together, Groq, LM Studio, Ollama's shim, etc.
- **Selection:** `providers/index.ts::resolveProvider()` — Rork if the build URL is present,
  else the configured OpenAI provider, else a `NoProviderError` the UI turns into a "configure
  AI in Settings" prompt.
- **Normalisation:** both providers emit the same `StreamEvent` stream (`providers/types.ts`), so
  the agent loop (`chat/agent.ts`) is provider-agnostic.
- **Offline behaviour:** the composer is disabled with a "chat needs a connection" hint; sent
  user messages persist locally and sync as normal chat rows. Assistant replies require a live
  request (no offline queue for LLM responses in MVP).

---

## 5. Conflict handling UX (explicit requirement of offline-first)

Because the same user can edit the same note on both devices while offline, the app **must**
surface conflicts rather than silently losing data (even though contention is rare for a single
user):

- On body-conflict, keep both: original + a **"conflicted copy"** note, flagged in the UI,
  linked to the original. (Familiar Dropbox/Obsidian-Sync pattern.)
- Show a small **sync status indicator** (idle / syncing / conflict) on both platforms.
- Never block editing on sync; reconcile in the background.

### 5.1 Online-only chat surface
Chat is the single feature that requires connectivity (§4a). When offline, disable the composer
with a clear hint; everything else (notes, board, search, graph) remains fully usable offline.

---

## 6. Schema changes required (concrete)

Add via new numbered migrations in `electron/db/schema.ts` (both desktop + mobile run them):

1. **`tags`**: add `created_at`, `updated_at`, `version`, `deleted_at`.
2. **Tombstones / `deleted_at`** on: `board_columns`, `tags`, `chat_threads`, `chat_messages`,
   and (when in scope) `idea_flow_*`. (Notes/cards/projects/workspaces already have `archived_at`
   — decide whether archive == tombstone or add a separate `deleted_at`.)
3. **New `sync_changelog` table**: `(id, entity_type, entity_id, op, hlc, origin_device, payload, created_at)`.
4. **New `sync_state` table**: per-peer last-seen HLC watermark + this device's HLC + `device_id`.
5. **Add `version` (+ HLC column) to all syncable tables** that lack it, and **enforce CAS** on
   the renderer write path (`db-handlers.ts` → guarded `WHERE id=? AND version=?`).

These are additive/backward-compatible migrations; the desktop keeps working throughout.

---

## 7. Decisions

### Resolved
1. **Sync transport** → **synced-folder oplog** (no backend, local-first). *(§3)*
2. **Scope** → **2 personal devices, single user.** No multi-user; LWW + conflict-copy is enough (no CRDTs). *(§4)*
3. **Chat** → **online-only via Rork AI toolkit** using the Vercel AI SDK custom provider. *(§4a)*

### Still open
4. **Knowledge Graph scope** — recommend a **read-only, simplified force graph of notes+links+tags**
   from the local DB (feasible in RN via `react-native-skia` or an SVG lib). The full D3 desktop
   experience is not feasible on RN. **Confirm the simplified read-only version.**
5. **Attachments/images** — how do binary assets (`assets/`, `attachments/`) reach mobile? Options:
   out of MVP, sync via the same folder, or lazy-fetch when online. **Recommend out of MVP** (notes
   render text; show a placeholder for images) to keep the first sync scope small.
6. **App Store distribution** — personal (Expo dev build, simplest) vs public listing (adds review +
   privacy policy). **Recommend Expo dev build** for a 2-device personal tool unless public release
   is a goal.

---

## 8. Phased roadmap

### Phase 0 — Sync spike / de-risk (highest priority)
Prove the sync protocol in isolation, no UI. Two `better-sqlite3` DBs on the desktop, an
oplog + HLC + tombstone layer, exchange changes via a local folder, assert convergence under
concurrent edits + deletes + conflicts. **Exit:** two divergent DBs reconcile to an identical
state with a generated conflict-copy on body conflict, zero data loss.

### Phase 1 — Schema & changelog on desktop
Land the additive migrations (§6), the write-wrapper that populates `sync_changelog`, HLC, and
CAS enforcement — **in the existing desktop app**, shipped and stable, before any mobile code.
**Exit:** desktop runs normally; every mutation is logged; `test:all` green.

### Phase 2 — Shared `@cairn/core` extraction
Carve out domain types, zod schemas, store logic, and the sync protocol into a package
consumed by both Electron renderer and Expo. **Exit:** desktop fully works consuming the core.

### Phase 3 — Expo app skeleton + local DB + read-only sync
Expo app with `expo-sqlite`, the shared schema/migrations, and one-way sync-in (desktop→mobile).
Read-only MVP screens: Notes viewer, Board viewer, Search. **Exit:** browse a synced snapshot
of the workspace on a phone, fully offline.

### Phase 4 — Bidirectional sync + mobile writes
Enable mobile writes (note edit, create/move cards) and two-way reconcile with conflict UX (§5).
**Exit:** edit offline on phone and desktop, reconnect, converge cleanly with conflicts surfaced.

### Phase 5 — Chat + lightweight Knowledge Graph
Add online-only Chat via the Rork toolkit (Vercel AI SDK custom provider, §4a) and the
simplified read-only graph (per decision #4). **Exit:** MVP feature-complete.

### Phase 6 — Distribution & hardening
Transport hardening, encryption at rest for the mobile DB, distribution (Expo dev build per
decision #6). Store submission only if public release becomes a goal.

---

## 9. Effort & risk assessment

- **Dominant risk:** the sync engine (Phases 0–1, 4). Getting delete-propagation, conflict
  resolution, and skew-safety right is where offline-first projects fail. Phase 0 exists
  specifically to prove this before investing in mobile UI.
- **Bounded work:** the Expo UI (Phases 3–5) — standard RN, MVP scope is deliberately small.
- **Reused, not rebuilt:** collision-free IDs, the `.md`/file-watcher precedent, existing
  `updated_at`/`version`/`archived_at` scaffolding, the single write choke point in `queries.ts`.
- **The one hard rule:** **never sync the binary `cairn.db` through a file-sync service.**
  Always sync the oplog (+ `.md` files). Violating this is the most likely cause of catastrophic
  data loss.

---

## Appendix — key source references

- Schema & migrations: `electron/db/schema.ts` (notes.version L308; cards.version L317; tags L93-98; archived_at pattern)
- ID generation (`nanoid(12)`): `electron/db/utils.ts:6,9-11`
- Timestamps (`ts()`): `electron/db/utils.ts:14-15`
- Write path / version increment: `electron/db/queries.ts:215,357`
- Optimistic-concurrency (advisory, MCP-only): `electron/mcp/db.ts:181-197`, `electron/mcp/tools/notes.ts:126-131`
- Notes dual-write + frontmatter: `electron/shared/notes-io.ts:16-20,159-185`
- Note reconciliation (LWW): `electron/notes-files.ts:53-141,287-322`
- File-watcher + echo-suppression: `electron/file-watcher.ts:31-46,86-156`
- `db:changed` broadcast (zero-payload): `electron/ipc/registry.ts:83-89,122-134`
- Existing LAN mobile server (reusable transport, not the sync engine): `electron/lib/mobile-server.ts`
- Static export config: `next.config.ts`
