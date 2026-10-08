/**
 * Unit tests for buildCordisUserContent — Cairn's message-shaping helper
 * that maps ChatRequest.images (image data URLs + PDFs) to dsh's user-
 * message ContentBlock[]. The previous CairnAttachmentStore class was
 * retired in favour of @deepseek-ai/dsh-attachment-local (see the docblock
 * on cairn-attachment-store.ts).
 *
 * These tests fake the mounted attachment store rather than booting the
 * real dsh one — we're guarding Cairn's shaping logic (data-URL parsing,
 * text-first ordering, PDF degradation, no-store fallback), not the
 * upstream store's image round-trip.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Context } from "@deepseek-ai/cordis";
import { buildCordisUserContent, CairnAttachmentStore, pinTurnAttachments, __setBlobsBudgetForTest } from "./cairn-attachment-store";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PDF_DATA_URL = "data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCg==";

/** A fake ctx whose get("attachments") returns the given store shape. */
function ctxWith(store: unknown) {
  return { get: (n: string) => (n === "attachments" ? store : undefined) } as never;
}

function makeFakeStore() {
  const saveImage = vi.fn(async (input: { data: Uint8Array; mediaType: string; name?: string }) => ({
    id: "att-1",
    variantId: "orig",
    mediaType: input.mediaType,
    width: 1,
    height: 1,
    bytes: input.data.byteLength,
    name: input.name,
  }));
  return {
    saveImage,
    imageLimits: { mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
  };
}

describe("buildCordisUserContent", () => {
  it("returns text-only when there are no attachments", async () => {
    const blocks = await buildCordisUserContent(ctxWith(undefined), "hello", undefined);
    expect(blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("returns text-only when the mounted store is missing (images silently dropped)", async () => {
    const blocks = await buildCordisUserContent(ctxWith(undefined), "hello", [
      { kind: "image", dataUrl: PNG_DATA_URL, name: "a.png" },
    ]);
    expect(blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("admits an image through the store and emits an ImageBlock after the text", async () => {
    const store = makeFakeStore();
    const blocks = await buildCordisUserContent(ctxWith(store), "look at this", [
      { kind: "image", dataUrl: PNG_DATA_URL, name: "a.png" },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "look at this" });
    expect(blocks[1].type).toBe("image");
    expect(store.saveImage).toHaveBeenCalledOnce();
    const arg = store.saveImage.mock.calls[0][0];
    expect(arg.mediaType).toBe("image/png");
    expect(arg.name).toBe("a.png");
  });

  it("degrades PDF attachments to a text notice (no document block in dsh yet)", async () => {
    const store = makeFakeStore();
    const blocks = await buildCordisUserContent(ctxWith(store), "read this", [
      { kind: "pdf", dataUrl: PDF_DATA_URL, name: "report.pdf" },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "read this" });
    expect(blocks[1].type).toBe("text");
    expect((blocks[1] as { text: string }).text).toContain("PDF");
    expect((blocks[1] as { text: string }).text).toContain("report.pdf");
    expect(store.saveImage).not.toHaveBeenCalled();
  });

  it("skips images with an unsupported media type (fail-soft, keep the turn alive)", async () => {
    const store = makeFakeStore();
    const blocks = await buildCordisUserContent(ctxWith(store), "hi", [
      { kind: "image", dataUrl: "data:image/tiff;base64,AAAA", name: "x.tiff" },
    ]);
    expect(blocks).toEqual([{ type: "text", text: "hi" }]);
    expect(store.saveImage).not.toHaveBeenCalled();
  });

  it("swallows a store rejection instead of failing the turn", async () => {
    const store = {
      ...makeFakeStore(),
      saveImage: vi.fn(async () => {
        throw new Error("too large");
      }),
    };
    const blocks = await buildCordisUserContent(ctxWith(store), "hi", [
      { kind: "image", dataUrl: PNG_DATA_URL, name: "a.png" },
    ]);
    expect(blocks).toEqual([{ type: "text", text: "hi" }]);
  });

  it("infers image vs pdf from the media type when kind is not set", async () => {
    const store = makeFakeStore();
    const blocks = await buildCordisUserContent(ctxWith(store), "look", [
      { dataUrl: PNG_DATA_URL, name: "a.png" },
      { dataUrl: PDF_DATA_URL, name: "r.pdf" },
    ]);
    // text + image + text-pdf-notice
    expect(blocks).toHaveLength(3);
    expect(blocks[1].type).toBe("image");
    expect(blocks[2].type).toBe("text");
  });

  it("skips a data URL that doesn't parse (bad payload → text-only)", async () => {
    const store = makeFakeStore();
    const blocks = await buildCordisUserContent(ctxWith(store), "hi", [
      { kind: "image", dataUrl: "notadataurl", name: "x" },
    ]);
    expect(blocks).toEqual([{ type: "text", text: "hi" }]);
    expect(store.saveImage).not.toHaveBeenCalled();
  });

  it("enforces the per-message image-COUNT cap (drops the overflow)", async () => {
    const store = { ...makeFakeStore(), imageLimits: { mediaTypes: ["image/png"], maxImagesPerMessage: 2, maxMessageImageBytes: Infinity } };
    const imgs = Array.from({ length: 5 }, (_, i) => ({ kind: "image" as const, dataUrl: PNG_DATA_URL, name: `${i}.png` }));
    const blocks = await buildCordisUserContent(ctxWith(store), "many", imgs);
    // text + at most 2 images (the count cap), rest dropped.
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(2);
    expect(store.saveImage).toHaveBeenCalledTimes(2);
  });

  it("enforces the per-message aggregate BYTE cap (drops the overflow)", async () => {
    // PNG_DATA_URL decodes to ~70 bytes; a 100-byte budget admits 1, drops the rest.
    const store = { ...makeFakeStore(), imageLimits: { mediaTypes: ["image/png"], maxImagesPerMessage: Infinity, maxMessageImageBytes: 100 } };
    const imgs = Array.from({ length: 4 }, (_, i) => ({ kind: "image" as const, dataUrl: PNG_DATA_URL, name: `${i}.png` }));
    const blocks = await buildCordisUserContent(ctxWith(store), "big", imgs);
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
    expect(store.saveImage).toHaveBeenCalledOnce();
  });
});

describe("CairnAttachmentStore retention budget", () => {
  afterEach(() => { __setBlobsBudgetForTest(undefined); });

  /** Distinct 1px PNG payloads (trailing byte differs; header dims identical). */
  function pngVariant(tag: number): Uint8Array {
    const base = Buffer.from(PNG_DATA_URL.split(",", 2)[1], "base64");
    return new Uint8Array([...base, tag]);
  }

  it("evicts least-recently-used entries past the budget, failing closed", async () => {
    // ~71 bytes each; a 150-byte budget holds two, not three.
    __setBlobsBudgetForTest(150);
    const ctx = new Context();
    try {
      const store = new CairnAttachmentStore(ctx);
      const a = await store.saveImage({ data: pngVariant(1), mediaType: "image/png" });
      const b = await store.saveImage({ data: pngVariant(2), mediaType: "image/png" });
      await store.saveImage({ data: pngVariant(3), mediaType: "image/png" });
      await expect(store.readImage(a)).rejects.toThrow(/not found/i);
      await expect(store.readImage(b)).resolves.toBeDefined();
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("refreshes recency on read, so hot entries survive", async () => {
    __setBlobsBudgetForTest(150);
    const ctx = new Context();
    try {
      const store = new CairnAttachmentStore(ctx);
      const a = await store.saveImage({ data: pngVariant(1), mediaType: "image/png" });
      await store.saveImage({ data: pngVariant(2), mediaType: "image/png" });
      await store.readImage(a);
      await store.saveImage({ data: pngVariant(3), mediaType: "image/png" });
      await expect(store.readImage(a)).resolves.toBeDefined();
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("pinned entries survive eviction pressure; unpin restores evictability", async () => {
    __setBlobsBudgetForTest(150);
    const ctx = new Context();
    try {
      const store = new CairnAttachmentStore(ctx);
      const a = await store.saveImage({ data: pngVariant(1), mediaType: "image/png" });
      const b = await store.saveImage({ data: pngVariant(2), mediaType: "image/png" });
      store.pin(String(a.attachmentId));
      await store.saveImage({ data: pngVariant(3), mediaType: "image/png" });
      // Without the pin, save-3 would have evicted oldest-a and kept b. b's
      // absence proves the pin held — and misses don't touch LRU order.
      await expect(store.readImage(b)).rejects.toThrow(/not found/i);
      store.unpin(String(a.attachmentId));
      await store.saveImage({ data: pngVariant(4), mediaType: "image/png" });
      // Order was {a, c}: unpinned a is oldest again → evicted.
      await expect(store.readImage(a)).rejects.toThrow(/not found/i);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("pinTurnAttachments pins image blocks and releases them via the disposer", async () => {
    __setBlobsBudgetForTest(150);
    const ctx = new Context();
    try {
      const store = new CairnAttachmentStore(ctx);
      const a = await store.saveImage({ data: pngVariant(1), mediaType: "image/png" });
      const b = await store.saveImage({ data: pngVariant(2), mediaType: "image/png" });
      const release = pinTurnAttachments(store, [
        { type: "image", attachment: a },
        { type: "text", text: "no attachment here" },
      ]);
      await store.saveImage({ data: pngVariant(3), mediaType: "image/png" });
      // b's absence proves the pin held (otherwise oldest-a would have gone).
      await expect(store.readImage(b)).rejects.toThrow(/not found/i);
      release();
      await store.saveImage({ data: pngVariant(4), mediaType: "image/png" });
      // Released a is oldest again → evicted; c survives.
      await expect(store.readImage(a)).rejects.toThrow(/not found/i);
      // Unknown shapes and missing stores never throw.
      expect(() => pinTurnAttachments(undefined, [{ type: "image" }])()).not.toThrow();
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

describe("CairnAttachmentStore disk persistence", () => {
  const PNG = new Uint8Array(Buffer.from(PNG_DATA_URL.split(",")[1], "base64"));
  const target = { width: 1, height: 1, maxBytes: 1024 } as never;
  /** One store per fresh Context — a new Context stands in for an app restart. */
  async function withStore<T>(root: string | undefined, fn: (store: CairnAttachmentStore) => Promise<T>): Promise<T> {
    const ctx = new Context();
    try {
      return await fn(new CairnAttachmentStore(ctx, root ? { root } : undefined));
    } finally {
      await ctx.fiber.dispose();
    }
  }

  it("reloads an image from disk in a fresh store (survives a restart)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-att-"));
    try {
      const ref = await withStore(root, (store) => store.saveImage({ data: PNG, mediaType: "image/png" }));
      expect(fs.existsSync(path.join(root, String(ref.attachmentId)))).toBe(true);
      await withStore(root, async (fresh) => {
        expect(fresh.has(String(ref.attachmentId))).toBe(true);
        const req = await fresh.readImageRequest(ref, target);
        expect(Buffer.from(req.data).equals(Buffer.from(PNG))).toBe(true);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a missing or tampered disk copy as not found", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-att-"));
    try {
      const ref = await withStore(root, (store) => store.saveImage({ data: PNG, mediaType: "image/png" }));
      const id = String(ref.attachmentId);
      fs.writeFileSync(path.join(root, id), Buffer.from("not the image"));
      await withStore(root, async (fresh) => {
        // The tampered file still exists, but it must not count as available.
        expect(fresh.has(id)).toBe(false);
        await expect(fresh.readImage(ref)).rejects.toThrow(/not found/);
        fs.rmSync(path.join(root, id));
        expect(fresh.has(id)).toBe(false);
      });
      // Memory-only store (no root) keeps the old behaviour.
      await withStore(undefined, async (mem) => expect(mem.has(id)).toBe(false));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-saving an image repairs a corrupt disk copy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-att-"));
    try {
      const ref = await withStore(root, (store) => store.saveImage({ data: PNG, mediaType: "image/png" }));
      const file = path.join(root, String(ref.attachmentId));
      fs.writeFileSync(file, Buffer.from("corrupt"));
      await withStore(root, (store) => store.saveImage({ data: PNG, mediaType: "image/png" }));
      expect(Buffer.from(fs.readFileSync(file)).equals(Buffer.from(PNG))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes the disk copy's mtime when the image is read, so the sweep keeps it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-att-"));
    try {
      const ref = await withStore(root, (store) => store.saveImage({ data: PNG, mediaType: "image/png" }));
      const file = path.join(root, String(ref.attachmentId));
      const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
      fs.utimesSync(file, old, old);
      await withStore(root, (fresh) => fresh.readImageRequest(ref, target));
      expect(fs.statSync(file).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
