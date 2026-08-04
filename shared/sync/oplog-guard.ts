/**
 * Cairn Sync — platform-neutral oplog entry validation
 *
 * Both the desktop (shared/sync/transport.ts) and mobile
 * (mobile/src/sync/fs-transport.ts) transports parse peer `.ndjson` oplog
 * files and must agree byte-for-byte on which entries are well-formed enough to
 * reach `applyRemote`. This module is the single source of that contract —
 * shared/sync/transport.ts imports `node:fs`, so mobile cannot import it
 * directly. Keeping the two copies in one place means the `observed` /
 * `tombstone` causal fields can only drift in one file.
 *
 * No Node imports here — safe for the React-Native bundler.
 */

import type { OplogEntry } from "./engine";
import { decodeHlc } from "./hlc";

const OPS = new Set(["put", "delete"]);

function validHlc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    decodeHlc(value);
    return true;
  } catch {
    return false;
  }
}

/** Structural guard so only well-formed entries reach applyRemote. */
function isOplogEntry(v: unknown): v is OplogEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  const observedValid = e.observed === undefined || (
    typeof e.observed === "object" &&
    e.observed !== null &&
    !Array.isArray(e.observed) &&
    Object.values(e.observed).every(validHlc)
  );
  const tombstoneValid = e.tombstone === undefined || (
    typeof e.tombstone === "object" &&
    e.tombstone !== null &&
    validHlc((e.tombstone as Record<string, unknown>).hlc) &&
    typeof (e.tombstone as Record<string, unknown>).origin === "string" &&
    decodeHlc((e.tombstone as Record<string, unknown>).hlc as string).deviceId === (e.tombstone as Record<string, unknown>).origin
  );
  // A `put` must carry a full row snapshot — a null or array payload can't be a
  // valid record and would silently produce an empty/undefined row on apply.
  // Non-put ops keep the looser legacy rule (null, or an object/record).
  const payloadValid = e.op === "put"
    ? typeof e.payload === "object" && e.payload !== null && !Array.isArray(e.payload)
    : e.payload === null || (typeof e.payload === "object" && e.payload !== null && !Array.isArray(e.payload));
  return (
    validHlc(e.hlc) &&
    typeof e.origin === "string" &&
    decodeHlc(e.hlc).deviceId === e.origin &&
    typeof e.entity === "string" &&
    typeof e.entity_id === "string" &&
    typeof e.op === "string" &&
    OPS.has(e.op) &&
    payloadValid &&
    observedValid &&
    tombstoneValid
  );
}

export { validHlc, isOplogEntry };
