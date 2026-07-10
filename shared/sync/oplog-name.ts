/**
 * Oplog FILENAME convention — pure string helpers, no Node/fs deps so both the
 * Node desktop transport (`transport.ts`) and the React-Native mobile transport
 * (`mobile/src/sync/fs-transport.ts`) can share one source of truth for how the
 * source (= workspace) is encoded in a filename.
 *
 * Layout inside the shared folder:
 *   oplog-<deviceId>-<workspaceId>.ndjson   — source-scoped (current)
 *   oplog-<deviceId>.ndjson                 — legacy, unsuffixed (still read)
 *
 * Delimiter rule: the deviceId is minted from `Math.random().toString(36)`
 * ("desktop_…"/"mobile_…") so it NEVER contains "-". The workspaceId is a nanoid
 * whose alphabet DOES include "-" and may even start or end with one. So the
 * FIRST "-" after the `oplog-` prefix is the unambiguous delimiter — never
 * lastIndexOf, which would truncate a workspaceId ending in "-".
 */

/**
 * Reject ids that could escape the sync folder or corrupt the filename. "-" and
 * "_" are permitted because device/workspace ids contain them; path separators,
 * traversal tokens, and dots-only names are rejected.
 */
export function assertSafeId(id: string, kind: "deviceId" | "workspaceId"): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`Unsafe sync ${kind}: ${JSON.stringify(id)}`);
  }
}

/**
 * Oplog filename. With `workspaceId`, encodes the source as a suffix
 * (`oplog-<deviceId>-<workspaceId>.ndjson`); omitting it yields the legacy
 * `oplog-<deviceId>.ndjson` name.
 */
export function oplogFileName(deviceId: string, workspaceId?: string): string {
  assertSafeId(deviceId, "deviceId");
  if (workspaceId == null || workspaceId === "") return `oplog-${deviceId}.ndjson`;
  assertSafeId(workspaceId, "workspaceId");
  return `oplog-${deviceId}-${workspaceId}.ndjson`;
}

/**
 * True if `fileName` is an oplog belonging to a KNOWN `workspaceId` — matched by
 * the full id as a suffix (never split on "-"), so a "-" in an id can't misroute
 * the match. Used by readers that already know which workspace they want.
 */
export function isOplogForWorkspace(fileName: string, workspaceId: string): boolean {
  return fileName.startsWith("oplog-") && fileName.endsWith(`-${workspaceId}.ndjson`);
}

/**
 * Extract the workspaceId from an oplog filename, for DISCOVERY — when the
 * reader does NOT yet know which workspaces exist and must derive the id from
 * the name. Splits on the FIRST "-" (see delimiter rule above). Returns null for
 * non-oplog names and legacy unsuffixed files (which carry no workspace).
 */
export function parseWorkspaceIdFromOplogName(fileName: string): string | null {
  if (!fileName.startsWith("oplog-") || !fileName.endsWith(".ndjson")) return null;
  const stem = fileName.slice("oplog-".length, -".ndjson".length);
  const dash = stem.indexOf("-");
  if (dash < 0) return null; // legacy unsuffixed — no discoverable workspace
  const workspaceId = stem.slice(dash + 1);
  return workspaceId || null;
}
