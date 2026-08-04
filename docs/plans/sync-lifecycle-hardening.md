# Sync Lifecycle Hardening — Delete/Resurrection & Stale-Peer Safety

Status: Phase 1 and Phase 2 implemented
Owner: —
Date: 2026-07-24
Related: `shared/sync/engine.ts`, `shared/sync/hlc.ts`, `mobile/src/db/queries.ts`, `electron/db/queries.ts`, `electron/sync/desktop-sync.ts`, `docs/plans/mobile-app-viability.md` (§4–§5)

---

## 1. Reported symptoms

Two data-loss / data-integrity bugs observed when one device (mobile) had a **stale
oplog / stale local rows** (days behind), then synced:

1. **Note vanished.** Created a note on desktop, linked it to a task via MCP; after
   mobile (stale) synced, the note disappeared.
2. **Note resurrected.** Deleted a note on desktop (manual); after mobile (stale)
   synced, the deleted note came back.

Both point at the reconciliation lifecycle — specifically how deletes, creates, and
last-writer-wins (LWW) interact when one peer carries stale state.

---

## 2. Root cause analysis

### 2.1 "Stale oplog" is a symptom; **stale HLC vs delete ordering** is the cause

`Hlc.send()` does `physical = max(prevPhysical, wall)` (`shared/sync/hlc.ts:94`). A device
that hasn't *synced* for days still advances its wall clock, so its new stamps are **not
literally old** — they can be numerically *higher* than a legitimate delete that happened
on the other device. Reconcile is pure LWW by `compareHlc` with **no domain-aware
tie-break** (`shared/sync/engine.ts:494`): a `put` beats a `delete` iff its HLC is higher,
regardless of user intent or which action was "more recent" in real terms.

### 2.2 Symptom 2 (resurrection) — the direct mechanism

- Desktop `deleteNote` **physically removes** the row (`DELETE FROM notes`,
  `electron/db/queries.ts:280`). The AFTER-DELETE trigger stages a `delete` op.
- On drain, `UPDATE ... SET deleted_at` matches **zero rows** (row already gone), so the
  engine inserts a **tombstone shell** to arm the staleness guard
  (`shared/sync/engine.ts:205-220`).
- The shell only protects against a peer `put` **older** than the delete. If the stale
  mobile peer holds a `put` for that note with a **higher HLC** than the delete (its wall
  clock is current; or `backfill()` re-stamped the row with a fresh HLC — see 2.4), then in
  `reconcileOne` the delete is treated as **stale** (`compareHlc(deleteHlc, putHlc) <= 0`)
  and **skipped**, and mobile's `put` revives the row. **Note resurrects.**

### 2.3 Symptom 1 (disappearance) — the direct mechanism

- The link write updates **two** entities: `notes.linked_card_ids` and
  `task_cards.linked_note_ids` (mobile `applyLinkChange`, `mobile/src/db/queries.ts:610`;
  desktop equivalent). These are separate oplog rows.
- `mergeForPut` bases the merged row on the **remote** payload (it won LWW) and only
  set-unions the array columns (`shared/sync/engine.ts:602-621`). If the stale peer's row
  wins LWW on the `notes` entity, the note's **scalar** state (including a stale/absent
  representation of "alive") overwrites desktop's fresh create.
- Compounded by the **hard-delete vs soft-delete asymmetry** (2.4): a freshly-created note
  on desktop that was never seen by the stale peer can be reconciled against a
  tombstone-shell or an absent row and lose.

### 2.4 Structural weaknesses (the real backlog)

1. **No delete-wins / grace semantics.** `delete` vs `put` is pure HLC LWW. There is no
   "an explicit, recent delete beats a resurrecting put."
2. **Hard-delete (desktop) vs soft-delete (mobile) asymmetry.** Two representations of
   "gone," reconciled through a fragile tombstone-shell mechanism that only guards the
   older-put case.
3. **`backfill()` re-stamps rows with fresh HLCs** (`shared/sync/engine.ts:283-284`). A
   stale device's first backfill can mint **newer-than-reality** stamps for old rows,
   inverting causality against a legitimate remote delete.
4. **No durable tombstone HLC comparison.** The shell records `deleted_at` + `hlc`, but the
   guard is one-directional; there is no persisted "delete happened at HLC D, reject any put
   whose causal ancestor precedes D."
5. **No user-facing visibility / recovery.** When a note vanishes or resurrects, there is no
   activity log explaining why and no one-tap restore.

---

## 3. Chosen policy: delete-wins within a grace window

(Decided with owner.) An explicit `delete` beats a `put` **unless the put is causally after
the delete**. Concretely:

- Persist the delete as a **durable tombstone** carrying the delete's HLC (`deleted_at` +
  the HLC at delete time), never garbage-collected within a retention window.
- **Causal-evidence mechanism.** "Causally after" is proven, not inferred from a raw HLC
  comparison (which stale-but-current wall clocks defeat — see 2.1/2.4). Every `put` and
  `delete` op carries an **observation token**: the origin device's acknowledged-HLC
  frontier for the target entity's origin — i.e. the highest HLC that origin had *observed*
  from the deleting device at the time it produced the op. Equivalently this may be carried
  as a compact **version vector** (per-origin max-HLC map) attached to the op. A `put`
  counts as causal-after a delete **iff** its observation token/vector dominates the
  tombstone's `delete_hlc` for the deleting origin — meaning the put's author had already
  seen the delete. A bare `compareHlc(putHlc, deleteHlc) > 0` is **not** sufficient evidence.
- In `reconcileOne`, when an incoming `put` targets a row that is **tombstoned locally**:
  - Apply the put (un-delete) **only if** `reconcileOne` can prove, using the put's
    observation token/version vector, that the put's origin had observed the delete
    (i.e. the token dominates the tombstone's `delete_hlc`). A higher raw HLC alone must
    **not** cause resurrection.
  - Otherwise the delete wins: keep the row tombstoned, do **not** resurrect.
- Symmetrically, a `delete` arriving against a live local row wins unless the local row was
  edited causally-after the delete (same observation-token test, mirrored).

This blocks the stale-peer resurrection (2.2) while still allowing the legitimate
"someone edited it on device B after I deleted it on device A, and device B had seen my
delete" case. Where causality can't be established (no observed delete), **delete wins** —
the safe default — and the resurrecting content is preserved as a conflict copy so nothing
is silently lost.

---

## 4. Work plan (phased)

### Phase 1 — Delete-wins reconciliation (fixes Symptom 2)
- **1a.** ✅ Add a durable tombstone record keyed by (entity, entity_id) storing `delete_hlc`
  (persisted independently of the row, so a compacted/absent row still carries the delete
  fact). Engine-owned table: **`sync_row_base`**.
  - **Ownership.** The table is owned by the sync engine, not the domain schema. It is
    created and versioned by the engine's own migration path (not the note/task CRUD layer),
    so both runtimes agree on its shape and the domain queries never touch it directly.
  - **Schema migrations (both runtimes).** Desktop adds the table via a new schema version in
    `electron/db/schema.ts` (current head is v26 — add v27) guarded by the existing
    `PRAGMA user_version` migration runner in `electron/db/client.ts`. Mobile adds the mirror
    migration in `mobile/src/db/schema.ts` / its migration runner so existing installs get
    `sync_row_base` on upgrade without a full reset. Both migrations must be idempotent
    (`CREATE TABLE IF NOT EXISTS`) and back-compatible with a populated DB.
  - **Read/write adapters.** The engine accesses `sync_row_base` only through a small adapter
    pair so existing databases have a deployable persistence path:
    `getRowBase(entity, id)` / `upsertRowBase(entity, id, deleteHlc)` in the engine's DB
    layer (`shared/sync/engine.ts` plus the per-runtime query modules
    `electron/db/queries.ts` and `mobile/src/db/queries.ts`). Existing rows with no base
    record are treated as "no recorded delete" (adapter returns `null`), so pre-migration
    data degrades gracefully rather than erroring. The adapter must **create** the row base
    on delete, **access** it in `reconcileOne`, and **preserve** it across compaction.
- **1b.** ✅ In `reconcileOne`, gate `put`-over-tombstone on causal-after semantics (§3). Add
  the mirror gate for `delete`-over-live.
- **1c.** ✅ Preserve losing content as a conflict copy when delete wins over a divergent put
  (no silent loss).
- **Tests:** ✅ stale-peer put with higher wall-clock HLC must NOT resurrect a deleted note;
  legitimate edit-after-observed-delete MUST revive.

### Phase 2 — Unify delete representation (fixes Symptom 1 root) ✅ DONE
- **2a.** ✅ Desktop `deleteNote` now soft-deletes (`UPDATE notes SET deleted_at = COALESCE(deleted_at, now)`,
  idempotent) instead of `DELETE FROM notes`. The AFTER-UPDATE trigger already stages a `delete`
  op (keys off `NEW.deleted_at`, schema v26), so peers tombstone via the normal `drainPending`
  delete branch. `.md` removal is unchanged (delete handlers look up the row before deleting).
- **2b.** ✅ Audit result — **much smaller than expected**: desktop live list/search reads
  (`getNotes`, `findLiveNoteByTitle`, `searchNotes`, `getCards`) **already** filter
  `deleted_at IS NULL`; the old `deleteNote` comment claiming otherwise was stale. The only gap
  was by-id reads: `getNoteById` now filters tombstones (added `getNoteByIdIncludingTombstoned`
  for the disk projector, which must still see the tombstone to remove the orphan `.md`).
  `toNote` now exposes `deletedAt`.
- **2c.** Tombstone-shell in `drainPending` is **retained** (still needed for the
  created-then-deleted-then-compacted edge and the mobile paths) — but desktop soft-delete no
  longer depends on it.
- **Tests:** ✅ all 1298 pass; `engine.test.ts` + `queries.test.ts` updated to soft-delete
  semantics; `type-check:all` + `compile` clean. (create-then-link stale-peer survival test is a
  Phase 1 concern — the durable tombstone this phase provides is the prerequisite.)

### Phase 3 — Backfill causality safety
- **3a.** `backfill()` must **not** mint fresh HLCs that could leapfrog a peer's delete.
  Preserve each row's **existing `hlc`** in the seeded op wherever one exists — the stored
  HLC is the only authoritative causal stamp. Only where a pre-existing row has *no* HLC at
  all may backfill derive a placeholder from the row's `updated_at` (never `Date.now()`).
- **3b.** An `updated_at`-derived backfill stamp is a **best-effort ordering hint only** and
  must be explicitly prohibited from counting as authoritative causal evidence in the §3
  delete-wins test: a backfilled op carrying such a derived stamp must **not** be treated as
  having observed a peer's delete (its observation token is empty/unknown), so it can never
  resurrect a tombstoned row. Only a genuine, HLC-carrying, observation-tokened op can.
- **Tests:** a device backfilling old rows cannot resurrect a note another device already
  deleted.

### Phase 4 — Visibility & recovery (defensive, ships alongside)
- **4a.** Lightweight sync activity log: record applied ops (entity, op, hlc, origin,
  outcome: applied/skipped-stale/conflict-copy/delete-won) with a bounded ring buffer.
- **4b.** Surface "recently changed by sync" + "restore" affordance for notes that were
  tombstoned by a peer, so a surprise deletion is recoverable in one tap.

---

## 5. Files to touch

| Area | File |
|---|---|
| Reconcile / LWW / tombstones | `shared/sync/engine.ts` |
| HLC (causal-after helper) | `shared/sync/hlc.ts` |
| Desktop delete → soft-delete | `electron/db/queries.ts`, `electron/sync/desktop-sync.ts`, `electron/notes-files.ts`, `electron/file-watcher.ts` |
| Mobile parity (already soft-deletes) | `mobile/src/db/queries.ts` |
| Tests | `shared/sync/engine.test.ts` (+ new cases) |

---

## 6. Risks & notes

- ~~Changing desktop to soft-delete means **every desktop live query must exclude
  tombstones**~~ — **resolved in Phase 2**: the list/search reads already filtered
  `deleted_at IS NULL`; only the by-id reads needed the guard. No ghost rows.
- The tombstone table (Phase 1) needs a **retention/GC policy** so it doesn't grow unbounded;
  GC must never run inside the grace window that protects against stale peers. Use a
  **per-peer acknowledged-HLC watermark + a wall-clock grace floor** rather than "is the delete
  op still in the peer's oplog file" — compaction (`compactOplog`) can drop that op, so the
  file is not a stable signal. GC only when every known peer's watermark is past the delete HLC
  **and** the grace period has elapsed (guards unknown / reinstalled peers).
- **Stale/lost-peer safety for GC.** A tombstone must **not** be collected when a peer's
  acknowledged-HLC watermark is **missing or no longer trustworthy** — specifically after a
  peer reinstall or app-data loss, where the local watermark record may claim the peer is
  "caught up" while the peer has actually lost the acknowledgement:
  - Bind each watermark to an **install-independent peer identity** (a persistent device/sync
    identity that survives, and is regenerated on, reinstall — not the ephemeral oplog file or
    install path). Treat any **newly discovered or re-registered** peer identity as **unsafe**
    until that identity is validated against the recorded one.
  - While a peer is unsafe (identity unvalidated, watermark missing, or a reinstall/app-data
    loss is detected), it does **not** count toward the "every known peer past the delete HLC"
    GC condition. The affected tombstones are **retained beyond the grace period** until the
    peer either completes a **full resync** (re-establishing a trustworthy watermark) or its
    install-independent identity is re-validated.
  - This protocol lives **alongside** the per-peer watermark and the wall-clock grace floor:
    GC requires (a) every known peer's watermark past the delete HLC, (b) the grace floor
    elapsed, **and** (c) no known peer in the unsafe/unvalidated state.
- Two-device single-user scope (per `mobile-app-viability.md` §4) keeps this tractable — no
  CRDT needed; delete-wins + conflict-copy is sufficient.
