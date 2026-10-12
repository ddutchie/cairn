# Cairn Sync Relay (remote sync) — post-release plan

Status: parked until after the image-sync release. Gitignored on purpose (`/docs/private/`).
Date: 2026-10-12
Prereq: image sync over the iCloud folder is shipped (see `docs/plans/sync-attachments.md`).

## Why

Work PC (Windows, no iCloud, corp firewall) + home Mac + iPhone have no common folder. Mobile is iCloud-only
(`mobile/src/sync/folder.ts`). Current users: the owner + partner (dev builds), so we can iterate without a migration burden.

## Decision recap (from the original investigation)

- Obsidian-Sync style relay, not a shared SQLite file and not a thin client. Local SQLite everywhere + exchange oplogs.
- Reuse `shared/sync/engine.ts` (HLC, tombstones, conflict copy, idempotent replay). Add an HTTP transport beside the folder transport.
- Obsidian Sync reference: 5 MB/file + 1 GB (Standard), 200 MB/file + 10+ GB (Plus), attachments and version history count toward
  storage ([plans](https://obsidian.md/help/sync/plans)).

## Hard requirement: end-to-end encryption

Decided: encryption matters. Design it BEFORE the first server byte is written, because retrofitting is painful.

### Key model
- One random 256-bit **workspace key** per synced workspace. Never leaves devices unwrapped.
- Server stores only a **wrapped** copy: key encrypted with a key derived from a user passphrase (Argon2id) plus a
  **recovery key** (shown once; 24 words / base32). Lose both → data unrecoverable (state this in the UI).
- **Adding a device**: show a QR / short code on an enrolled device carrying the wrapped key + a one-time unwrap secret
  (phone↔desktop scan; work PC: type code). No passphrase on the server path.
- Rotating the key (device lost) = new workspace key, re-encrypt blobs lazily, re-publish oplog snapshot. Plan the envelope
  to carry a `kid` so old and new keys coexist during rotation.

### Envelope (new `shared/sync/crypto.ts`, platform-neutral, WebCrypto/libsodium)
- Oplog entry on the wire: `{ hlc, origin, v, kid, nonce, ct }` where `ct` = AEAD(entity, entity_id, op, payload, observed,
  tombstone). `hlc` stays plaintext so the server can order and serve `since_hlc` cursors (leaks timing, not content —
  accepted trade-off). `origin` is derivable from hlc already.
- AEAD: AES-256-GCM (WebCrypto exists on Electron, Workers and — via polyfill/expo-crypto — RN) or XChaCha20-Poly1305
  if we adopt libsodium. Bind `workspaceId` + `hlc` as associated data so entries can't be replayed across workspaces.
- Blobs: key by `HMAC-SHA256(workspaceKey, plaintextHash)` (not the plain sha256) so the server can't confirm "does this
  user have file X". Bytes = nonce‖ciphertext. Client verifies plaintext hash after decrypt, same as today's fetch path.
- `oplog-guard.ts` validates the decrypted entry; server validates only the outer envelope shape and size.
- Search, FTS, embeddings, agent tools are all local → unaffected.

### The iCloud/folder transport today is plaintext
Oplogs and `blobs-*/` in the iCloud folder are unencrypted beyond Apple's own protection (and iCloud Advanced Data
Protection, if enabled). Because the envelope is a transport-agnostic layer, the folder transport can opt into it
later (workspace setting). Not in the image-sync release; flag it in the release notes honestly.

## Architecture

- **Server**: Cloudflare Worker (Hono) + D1 (oplog index, devices, workspace key blobs) + R2 (blobs). Free tiers cover
  two users: R2 is 10 GB / 1M writes / 10M reads per month, no egress fees
  ([secondary source](https://agentdeals.dev/vendor/cloudflare-r2) — verify on Cloudflare's pricing page).
  Everything is outbound HTTPS 443, which is what the corp firewall allows. Test firewall reachability from the work PC first.
- **Self-host option**: same Hono app on Node + SQLite + local disk (Docker). Keeps the door open for goodwill/self-hosters.
- **Endpoints** (all scoped by workspaceId, device-token auth):
  - `POST /v1/devices/register`, `GET /v1/meta` (protocol version, quotas)
  - `POST /v1/push` (batch of envelopes; idempotent by `(origin, hlc)`)
  - `GET /v1/pull?workspaceId&since=<hlc>&limit=` (cursor paging)
  - `POST /v1/blobs/missing` (batch hash check), `PUT /v1/blobs/:id` (size-capped), `GET /v1/blobs/:id`
  - `GET/PUT /v1/keys` (wrapped workspace key)
- **Transport interface** (introduce in R1 so folder + HTTP are interchangeable): `OplogTransport { push, pullSince }` and
  `BlobStore { has, put, get }`. The image-sync release's folder code should already be shaped like this; refactor if not.

## Prerequisite engine work: incremental oplog

Today each device rewrites its WHOLE oplog file and every reader re-reads every peer file in full each cycle
(`writeOplogFile`, `readPeerOplogs`). Over HTTP that must become cursor-based:
- Persist a per-peer/remote high-water mark (`sync_state`, e.g. `remote_cursor:<server>`), push only entries with
  `seq > last_pushed_seq`, pull only `hlc > cursor`.
- Keep periodic **compaction/snapshot** (the engine already compacts) so a new device bootstraps from a snapshot + tail.
- Idempotent replay already makes retries safe.

## Phases

| # | Scope | Notes |
|---|-------|-------|
| R0 | Reachability spike: Worker hello-world + R2 PUT/GET from the work PC and phone on cellular | De-risks the firewall question first |
| R1 | Transport interfaces + incremental oplog (folder impl keeps working) | No server yet; unit-testable |
| R2 | `shared/sync/crypto.ts` envelope + key model + QR device enrolment | Tested standalone with vectors |
| R3 | Server MVP (Worker + D1 + R2), feature-flagged client, token in OS keychain / expo-secure-store | Two users, no billing |
| R4 | Desktop + mobile wiring in `syncDesktop` / `mobile/src/sync/sync.ts`, `SyncSettings.tsx` UI (provider choice: folder vs relay) | Migration: first relay sync = snapshot upload |
| R5 | Hardening: quotas, GC of unreferenced blobs (grace period), rate limits, backups, version history | |
| R6 | Billing (only if opening to others): Stripe subscriptions on web (avoid Apple IAP cut), entitlement check on push/pull | Not needed for two users |

## Risks / open questions

1. Is outbound HTTPS to `*.workers.dev` / a custom domain allowed on the work PC? (R0 answers this; a custom domain on
   a neutral name often passes proxies better than `workers.dev`.)
2. Can the work PC install/run the Electron build at all (locked installs)? If not, a web client is a different, larger project.
3. Passphrase UX vs recovery-key-only. Partner use suggests: recovery key + device QR, passphrase optional.
4. Per-file blob cap: keep 10 MB (matches `uploadAsset`) or raise for PDFs?
5. Mobile background sync limits on iOS (BGTask) — relay doesn't fix "sync only when app is open".
6. Image-sync release added the `attachments` manifest + protocol 4; relay protocol should start at protocol 5 with envelope.
