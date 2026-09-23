/**
 * Read-only full-log read of one stored session.
 *
 * dsh 0.1.5 removed `SessionPersistence.inspect()`. The supported read path is
 * `open(id, "read")` → `handle.read()` → `close()`: a read handle never takes
 * write ownership, so this is safe while a live agent holds the session.
 * Throws `SessionPersistenceNotFoundError` ("session … not found") for a
 * missing id, which callers already treat as an empty log.
 *
 * A legacy `inspect()` is still honoured when present (older backends, test
 * doubles).
 */

export interface SessionInspectionLike {
  header: { cwd?: string; [key: string]: unknown };
  events: readonly unknown[];
}

export interface InspectablePersistence {
  open?: (id: never, access: "read", options?: { signal?: AbortSignal }) => Promise<{
    header: SessionInspectionLike["header"];
    read: (offset?: number, length?: number, options?: { signal?: AbortSignal }) => Promise<{ events: readonly unknown[] }>;
    close: () => Promise<void>;
  }>;
  inspect?: (id: never, signal?: AbortSignal) => Promise<{ header?: unknown; events?: readonly unknown[] }>;
}

export async function inspectSession(pers: InspectablePersistence, id: unknown, signal?: AbortSignal): Promise<SessionInspectionLike> {
  if (typeof pers.inspect === "function") {
    const legacy = await pers.inspect(id as never, signal);
    return { header: (legacy?.header ?? {}) as SessionInspectionLike["header"], events: legacy?.events ?? [] };
  }
  if (typeof pers.open !== "function") throw new Error("session persistence has no read path");
  const handle = await pers.open(id as never, "read", { signal });
  try {
    const { events } = await handle.read(0, undefined, { signal });
    return { header: handle.header, events };
  } finally {
    await handle.close().catch(() => { });
  }
}
