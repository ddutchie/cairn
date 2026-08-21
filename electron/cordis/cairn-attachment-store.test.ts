/**
 * Unit tests for CairnAttachmentStore + buildCordisUserContent (2l): image
 * dimension decoding, saveImage/readImage round-trip, and content-block
 * construction (image -> ImageBlock, PDF -> graceful text note, no store ->
 * text-only). No live model / no Cordis context beyond a fake `get`.
 */
import { describe, it, expect } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { CairnAttachmentStore, buildCordisUserContent } from "./cairn-attachment-store";

// 1x1 PNG and 1x1 GIF (valid headers, decodable dimensions).
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const GIF_1x1 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function makeStore(): CairnAttachmentStore {
  // A real Cordis context — the Service base needs ctx.provide during construct.
  return new CairnAttachmentStore(new Context());
}

/** A ctx whose get("attachments") returns the given store. */
function ctxWith(store: unknown) {
  return { get: (n: string) => (n === "attachments" ? store : undefined) } as never;
}

describe("CairnAttachmentStore", () => {
  it("decodes PNG dimensions and round-trips bytes", async () => {
    const store = makeStore();
    const data = new Uint8Array(Buffer.from(PNG_1x1, "base64"));
    const ref = await store.saveImage({ data, mediaType: "image/png", name: "a.png" });
    expect(ref.width).toBe(1);
    expect(ref.height).toBe(1);
    expect(ref.mediaType).toBe("image/png");
    expect(ref.bytes).toBe(data.byteLength);
    const stored = await store.readImage(ref);
    expect(Buffer.from(stored.data).equals(Buffer.from(data))).toBe(true);
  });

  it("readImageRequest returns the model-request version (dsh 0.1.1 attachment API)", async () => {
    const store = makeStore();
    const data = new Uint8Array(Buffer.from(PNG_1x1, "base64"));
    const ref = await store.saveImage({ data, mediaType: "image/png" });
    const req = await store.readImageRequest(ref, { maxPixels: 40_000_000, maxBytes: 3_500_000 });
    // Bytes + metadata carried through (no re-encode — the stored bytes ARE the
    // request version), and the pi-ai adapter's required fields are populated.
    expect(Buffer.from(req.data).equals(Buffer.from(data))).toBe(true);
    expect(req.mediaType).toBe("image/png");
    expect([req.width, req.height]).toEqual([1, 1]);
    expect(req.bytes).toBe(data.byteLength);
    expect(req.depth).toBe("uchar");
    expect(req.space).toBe("srgb");
    expect(req.hasAlpha).toBe(true); // PNG can carry alpha
    expect(String(req.variantId)).toMatch(/^[0-9a-f]{64}$/);
    // variantId is deterministic over (attachmentId, policy).
    const again = await store.readImageRequest(ref, { maxPixels: 40_000_000, maxBytes: 3_500_000 });
    expect(String(again.variantId)).toBe(String(req.variantId));
  });

  it("decodes GIF dimensions", async () => {
    const store = makeStore();
    const data = new Uint8Array(Buffer.from(GIF_1x1, "base64"));
    const ref = await store.saveImage({ data, mediaType: "image/gif" });
    expect([ref.width, ref.height]).toEqual([1, 1]);
  });

  it("dedupes identical bytes to the same attachmentId", async () => {
    const store = makeStore();
    const data = new Uint8Array(Buffer.from(PNG_1x1, "base64"));
    const a = await store.saveImage({ data, mediaType: "image/png" });
    const b = await store.saveImage({ data, mediaType: "image/png" });
    expect(String(a.attachmentId)).toBe(String(b.attachmentId));
  });

  it("rejects a media type that does not match the bytes", async () => {
    const store = makeStore();
    const data = new Uint8Array(Buffer.from(PNG_1x1, "base64"));
    await expect(store.saveImage({ data, mediaType: "image/jpeg" })).rejects.toMatchObject({ code: "IMAGE_TYPE_MISMATCH" });
  });

  it("throws ATTACHMENT_NOT_FOUND for an unknown ref", async () => {
    const store = makeStore();
    await expect(
      store.readImage({ attachmentId: "deadbeef" as never, mediaType: "image/png", bytes: 1, width: 1, height: 1 }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
  });
});

describe("buildCordisUserContent", () => {
  it("returns text-only when there are no attachments", async () => {
    const blocks = await buildCordisUserContent(ctxWith(makeStore()), "hello", undefined);
    expect(blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("admits an image attachment into an ImageBlock", async () => {
    const store = makeStore();
    const blocks = await buildCordisUserContent(ctxWith(store), "look", [
      { kind: "image", dataUrl: `data:image/png;base64,${PNG_1x1}`, name: "shot.png" },
    ]);
    expect(blocks[0]).toEqual({ type: "text", text: "look" });
    expect(blocks[1].type).toBe("image");
    const img = blocks[1] as { type: "image"; attachment: { width: number; mediaType: string } };
    expect(img.attachment.width).toBe(1);
    expect(img.attachment.mediaType).toBe("image/png");
  });

  it("degrades a PDF to a text note (no document block in dsh)", async () => {
    const blocks = await buildCordisUserContent(ctxWith(makeStore()), "read this", [
      { kind: "pdf", dataUrl: "data:application/pdf;base64,cGRmYnl0ZXM=", name: "doc.pdf" },
    ]);
    expect(blocks.length).toBe(2);
    expect(blocks[1].type).toBe("text");
    expect((blocks[1] as { text: string }).text).toContain("doc.pdf");
    expect((blocks[1] as { text: string }).text.toLowerCase()).toContain("not yet supported");
  });

  it("falls back to text-only when no attachment store is mounted", async () => {
    const blocks = await buildCordisUserContent(ctxWith(undefined), "hi", [
      { kind: "image", dataUrl: `data:image/png;base64,${PNG_1x1}` },
    ]);
    expect(blocks).toEqual([{ type: "text", text: "hi" }]);
  });

  it("omits (does not throw on) an unparseable attachment", async () => {
    const blocks = await buildCordisUserContent(ctxWith(makeStore()), "hi", [
      { kind: "image", dataUrl: "not-a-data-url" },
    ]);
    expect(blocks).toEqual([{ type: "text", text: "hi" }]);
  });
});
