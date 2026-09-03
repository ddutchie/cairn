/**
 * Unit tests for the message-feedback surface (thumbs ratings + notes).
 *
 * Proves, with fakes and no live model:
 *   - the storage chain + feedback service + /feedback command mount in
 *     `getContext()` (ctx.messageFeedback, "feedback" in the command list);
 *   - `putMessageFeedback` carries the observed compare-and-set version,
 *     retries once on version-conflict, preserves a stored note across bare
 *     thumb clicks, and validates its inputs;
 *   - `getMessageFeedback` returns the item, null when unrated, and null for
 *     unknown sessions (bubble renders the unrated state).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { setPluginsRoot } from "./plugin-loader";
import { setSessionRoot, getContext } from "./run-cordis-loop";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { putMessageFeedback, getMessageFeedback } from "./message-feedback";

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-feedback-"));
  setSessionRoot(path.join(tmp, "sessions"));
  setPluginsRoot(path.join(tmp, "plugins"));
});

function item(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "msg-1",
    rating: "positive",
    version: "v-1",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function fakeService(existing: Array<ReturnType<typeof item>> = []) {
  const puts: Array<Record<string, unknown>> = [];
  let conflictOnce = false;
  type PutResult =
    | { ok: true; value: ReturnType<typeof item> }
    | { ok: false; error: { code: string; current?: ReturnType<typeof item> | null } };
  return {
    puts,
    armConflictOnce() { conflictOnce = true; },
    list: vi.fn(async () => ({ ok: true as const, value: { items: existing } })),
    put: vi.fn(async (req: Record<string, unknown>): Promise<PutResult> => {
      puts.push(req);
      if (conflictOnce) {
        conflictOnce = false;
        return { ok: false as const, error: { code: "version-conflict", current: item({ rating: "negative", version: "v-2" }) } };
      }
      return { ok: true as const, value: item({ rating: req.rating, ...(req.note !== undefined ? { note: req.note } : {}) }) };
    }),
  };
}

const ctxWith = (messageFeedback?: unknown) => ({ messageFeedback }) as never;

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "no-throw";
  } catch (err) {
    return (err as { code?: string }).code ?? "no-code";
  }
}

describe("feedback stack mount", () => {
  it("mounts ctx.messageFeedback and the /feedback command (no live model)", async () => {
    const ctx = await getContext();
    const service = (ctx as unknown as { messageFeedback?: { list?: unknown; put?: unknown; delete?: unknown } }).messageFeedback;
    expect(service, "ctx.messageFeedback mounted").toBeDefined();
    expect(typeof service?.list).toBe("function");
    expect(typeof service?.put).toBe("function");

    const commands = (ctx as unknown as { commands?: { list?: () => Array<{ name: string }> } }).commands;
    expect(commands?.list?.().map((c) => c.name)).toContain("feedback");
  }, 90000);
});

describe("putMessageFeedback", () => {
  it("puts a fresh rating with a null version", async () => {
    const service = fakeService();
    const result = await putMessageFeedback(ctxWith(service), { sessionId: "s", messageId: "msg-1", rating: "positive" });
    expect(service.put).toHaveBeenCalledTimes(1);
    expect(service.puts[0]).toMatchObject({ messageId: "msg-1", rating: "positive", ifVersion: null });
    expect(result).toMatchObject({ messageId: "msg-1", rating: "positive" });
  });

  it("carries the observed version for a re-rate", async () => {
    const service = fakeService([item({ version: "v-9" })]);
    await putMessageFeedback(ctxWith(service), { sessionId: "s", messageId: "msg-1", rating: "negative" });
    expect(service.puts[0]).toMatchObject({ rating: "negative", ifVersion: "v-9" });
  });

  it("preserves a stored note across a bare thumb click", async () => {
    const service = fakeService([item({ version: "v-3", note: "kept" })]);
    await putMessageFeedback(ctxWith(service), { sessionId: "s", messageId: "msg-1", rating: "negative" });
    expect(service.puts[0]).toMatchObject({ note: "kept", ifVersion: "v-3" });
  });

  it("retries once with the authoritative version on conflict", async () => {
    const service = fakeService([item({ version: "v-1" })]);
    service.armConflictOnce();
    const result = await putMessageFeedback(ctxWith(service), { sessionId: "s", messageId: "msg-1", rating: "positive" });
    expect(service.put).toHaveBeenCalledTimes(2);
    expect(service.puts[1]).toMatchObject({ ifVersion: "v-2" });
    expect(result).toMatchObject({ rating: "positive" });
  });

  it("rejects invalid ratings and missing ids as bad-request", async () => {
    const service = fakeService();
    expect(await codeOf(() => putMessageFeedback(ctxWith(service), { sessionId: "s", messageId: "m", rating: "meh" as never }))).toBe("bad-request");
    expect(await codeOf(() => putMessageFeedback(ctxWith(service), { sessionId: "", messageId: "m", rating: "positive" }))).toBe("bad-request");
    expect(service.put).not.toHaveBeenCalled();
  });

  it("fails unavailable when the service is not mounted", async () => {
    expect(await codeOf(() => putMessageFeedback(ctxWith(undefined), { sessionId: "s", messageId: "m", rating: "positive" }))).toBe("unavailable");
  });

  it("maps a target miss to the target-not-found code", async () => {
    const service = fakeService();
    service.put = vi.fn(async () => ({ ok: false as const, error: { code: "target-not-found" } }));
    expect(await codeOf(() => putMessageFeedback(ctxWith(service), { sessionId: "s", messageId: "nope", rating: "positive" }))).toBe("target-not-found");
  });
});

describe("getMessageFeedback", () => {
  it("returns the stored item, or null when unrated", async () => {
    const service = fakeService([item({ note: "n" })]);
    await expect(getMessageFeedback(ctxWith(service), "s", "msg-1")).resolves.toMatchObject({ rating: "positive", note: "n" });
    await expect(getMessageFeedback(ctxWith(service), "s", "other")).resolves.toBeNull();
  });

  it("returns null for unknown sessions so bubbles render unrated", async () => {
    const missing = { list: vi.fn(async () => ({ ok: false as const, error: { code: "session-not-found" } })) };
    await expect(getMessageFeedback({ messageFeedback: missing } as never, "ghost", "msg-1")).resolves.toBeNull();
  });
});
