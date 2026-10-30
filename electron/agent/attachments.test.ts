import { describe, expect, it } from "vitest";
import { MAX_IMAGES_PER_MESSAGE, prepareAttachments } from "./attachments";

const png = (bytes = 8) => `data:image/png;base64,${Buffer.alloc(bytes, 1).toString("base64")}`;

describe("prepareAttachments", () => {
  it("admits images and leaves the text alone", () => {
    const out = prepareAttachments("look", [{ dataUrl: png(), name: "a.png" }]);
    expect(out.text).toBe("look");
    expect(out.images).toEqual([{ mediaType: "image/png", data: Buffer.alloc(8, 1).toString("base64"), name: "a.png" }]);
  });
  it("tells the model about a PDF instead of dropping it silently", () => {
    const out = prepareAttachments("read", [{ kind: "pdf", dataUrl: "data:application/pdf;base64,AAAA", name: "spec.pdf" }]);
    expect(out.images).toEqual([]);
    expect(out.text).toContain('"spec.pdf"');
  });
  it("drops unsupported types, malformed urls and anything over the count limit", () => {
    const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 3 }, () => ({ dataUrl: png() }));
    const out = prepareAttachments("x", [{ dataUrl: "data:image/svg+xml;base64,AAAA" }, { dataUrl: "not a url" }, ...many]);
    expect(out.images).toHaveLength(MAX_IMAGES_PER_MESSAGE);
  });
});
