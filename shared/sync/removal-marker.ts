/**
 * Workspace-removal marker — pure helpers (no fs / RN deps) shared by the
 * desktop transport and the mobile transport.
 *
 * When a desktop removes its workspace from the shared folder ("Disconnect and
 * remove from folder") it deletes its own oplog + writes
 *   <syncFolder>/removed-<workspaceId>.json
 * so phones that still hold the workspace know it is gone, stop re-publishing
 * their own oplog (which would resurrect it for every other device), and offer
 * to remove their copy. Reconnecting the desktop to the same folder deletes the
 * marker and republishes, so the workspace re-syncs normally.
 */
import { assertSafeId } from "./oplog-name";

export interface RemovalMarker {
  workspaceId: string;
  /** ISO timestamp of the removal. */
  removedAt: string;
  /** Device that removed it. */
  deviceId: string;
}

const PREFIX = "removed-";
const SUFFIX = ".json";

/** Marker filename for a workspace. Throws on an unsafe id. */
export function removalMarkerName(workspaceId: string): string {
  assertSafeId(workspaceId, "workspaceId");
  return `${PREFIX}${workspaceId}${SUFFIX}`;
}

/** The workspaceId a marker filename belongs to, or null if it isn't a marker. */
export function parseRemovalMarkerName(fileName: string): string | null {
  if (!fileName.startsWith(PREFIX) || !fileName.endsWith(SUFFIX)) return null;
  const id = fileName.slice(PREFIX.length, fileName.length - SUFFIX.length);
  return id && /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== ".." ? id : null;
}

export function serializeRemovalMarker(m: RemovalMarker): string {
  return JSON.stringify(m);
}

/** Lenient parse: any file with a marker name counts, even if the body is partial (iCloud mid-sync). */
export function parseRemovalMarker(text: string, workspaceId: string): RemovalMarker {
  try {
    const v = JSON.parse(text) as Partial<RemovalMarker>;
    return {
      workspaceId,
      removedAt: typeof v.removedAt === "string" ? v.removedAt : "",
      deviceId: typeof v.deviceId === "string" ? v.deviceId : "",
    };
  } catch {
    return { workspaceId, removedAt: "", deviceId: "" };
  }
}
