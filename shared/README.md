# shared/

Portable, framework-agnostic code shared between the Cairn **desktop** app
(Electron + `better-sqlite3`) and the future **mobile** app (Expo +
`expo-sqlite`).

This is a *source-only shared folder*, not a published package — consumers
import it directly:

- **Desktop / Electron**: relative imports (`../../shared/sync`), bundled by
  esbuild. Type-checked via `tsconfig.shared.json`.
- **Mobile / Expo** (later, P3): a path alias (e.g. `@cairn/shared`) in the
  Expo project's `tsconfig`/`babel` config, pointing at this folder.

## Rules

- **No platform-specific dependencies.** Nothing here may import `electron`,
  Next.js, React Native, `better-sqlite3`, or `expo-sqlite` directly. Database
  access goes through the `SyncDb` adapter interface (`sync/db-adapter.ts`);
  each platform supplies a thin adapter.
- Keep it pure/deterministic where possible so it can be unit-tested once and
  trusted on both platforms.

## Contents

- `sync/` — the offline-first sync engine
  - `hlc.ts` — Hybrid Logical Clock
  - `engine.ts` — oplog capture drain + convergent reconcile (LWW +
    conflict-copy + set-union merge + tombstones)
  - `transport.ts` — synced-folder NDJSON oplog transport
  - `db-adapter.ts` — the minimal `SyncDb` interface both drivers satisfy
  - `schema.ts` — `SYNCABLE_TABLES` (single source of truth)
  - `index.ts` — public API barrel

Run the shared tests with: `npx vitest run shared/**/*.test.ts --project node`
