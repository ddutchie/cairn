# Sync: attachments (images) over the synced folder

Status: implemented (desktop + mobile read path). Remote relay is planned separately and intentionally not in the repo.
Related: `shared/sync/attachments.ts`, `electron/sync/attachments.ts`, `mobile/src/sync/blobs.ts`, `mobile/src/components/SyncedImage.tsx`

## Problem
Images embedded in notes (`![[photo.png]]`) did not sync: only DB rows travel in the oplog, the binary stays in
`<workspace>/attachments/`, so the peer received a dangling embed.

## Design
Two channels, both riding the existing synced folder:

1. **Manifest** — new syncable table `attachments` (migration v62 desktop / v9 mobile; oplog protocol 4). One row per
   `(sha256, embed name)`: `id = "<hash>:<name>"`, plus `workspace_id, hash, name, ext, size`. It replicates through the
   normal engine (HLC, tombstones, idempotent replay). Bytes never enter the oplog.
2. **Blobs** — write-once, content-addressed files at `<syncFolder>/blobs-<workspaceId>/<sha256>.<ext>`.
   No two devices ever write the same name with different bytes, so iCloud/Dropbox never merge anything.

### Desktop (`syncDesktop`, each tick)
1. `registerAttachments` — scan notes for `![[x]]` / `asset://x` (first scan = all notes = backfill; later scans only notes
   edited since the previous scan), hash the local file, insert a manifest row. Runs before drain so it ships in the same tick.
2. oplog write → read peers → apply (unchanged).
3. `publishBlobs` — copy local files the folder lacks. `fetchBlobs` — copy blobs for manifest rows we lack bytes for, into
   the workspace attachment folder (Obsidian `attachmentFolderPath` honoured, shared helper `host-shared/attachment-dir.ts`).
   Every fetch is sha256-verified before install; a short/partial read is retried next tick.

Safety: the user's own files are never overwritten (a name taken by different bytes is kept and the incoming file is saved as
`name-<hash8>.ext`; note bodies are NOT rewritten); manifest rows are untrusted (only well-formed hash/name/ext reach the
filesystem; path-traversal names are ignored); attachment failures never fail the oplog sync; ≤200 copies per tick.

### Mobile
Read path only. The iCloud folder is the store (placeholders give lazy download). After each sync, `requestMissingBlobs`
asks iCloud to download blobs of live manifest rows. `![[image.png]]` is rewritten by the shared preprocess to
`cairn://embed/<name>` and rendered by `SyncedImage` (manifest lookup → `expo-image`), which shows a placeholder and polls
until the file lands.

## Not in this change
- Phone-originated images (camera/photos inserted into a note): needs a photo-picker dependency (native rebuild) and a
  mobile write path into `blobs-*/`. The manifest + folder layout already support it.
- Encryption, GC of unreferenced blobs, per-type/Wi-Fi-only toggles, PDFs on mobile (placeholder remains).
- Known limit: manifest rows are registered when a note referencing the image is scanned; an image replaced in place under
  the same name produces a new row (old row/blob are not garbage-collected yet).
