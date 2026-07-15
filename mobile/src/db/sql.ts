/**
 * Shared SQL fragments used across the mobile query modules. Extracted so the
 * domain-split query files (queries.ts, embeddings-queries.ts, …) share one
 * definition of "live" and "not a conflict copy" rather than duplicating them.
 */

/** Excludes tombstoned (deleted_at) and archived rows. */
export const LIVE = "deleted_at IS NULL AND archived_at IS NULL";

/**
 * SQL fragment excluding conflict-copy note rows (id like `..._conflict_...`).
 * Conflict copies are surfaced separately via listConflictCopies() so they
 * don't clutter the normal note lists / counts.
 */
export const NOT_CONFLICT = `id NOT LIKE '%\\_conflict\\_%' ESCAPE '\\'`;
