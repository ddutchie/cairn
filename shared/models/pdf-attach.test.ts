/**
 * Unit tests for the shared PDF/attachment part helpers.
 */

import { describe, expect, it } from "vitest";
import {
  buildAttachmentParts,
  pdfDocumentPart,
  pdfTokenEstimate,
  supportsPdfInput,
} from "./pdf-attach";

const DATA_URL = "data:application/pdf;base64,SGVsbG8=";

describe("supportsPdfInput", () => {
  it("is false for unknown models", () => {
    expect(supportsPdfInput(null)).toBe(false);
  });

  it("follows the catalog modalities", () => {
    expect(supportsPdfInput({ modes: ["text", "image", "pdf"] } as never)).toBe(true);
    expect(supportsPdfInput({ modes: ["text", "image"] } as never)).toBe(false);
    expect(supportsPdfInput({ modes: [] } as never)).toBe(false);
  });

  it("never crashes on legacy entries missing `modes`", () => {
    expect(supportsPdfInput({} as never)).toBe(false);
  });
});

describe("pdfDocumentPart", () => {
  it("emits an Anthropic-style base64 document part", () => {
    expect(pdfDocumentPart(DATA_URL)).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "SGVsbG8=" },
    });
  });
});

describe("buildAttachmentParts", () => {
  it("leads with the text part and appends each attachment", () => {
    const parts = buildAttachmentParts("hi", [
      { kind: "image", dataUrl: "data:image/png;base64,AAAA" },
      { kind: "pdf", dataUrl: DATA_URL },
    ]);
    expect(parts[0]).toEqual({ type: "text", text: "hi" });
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
    expect(parts[2]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "SGVsbG8=" } });
  });
});

describe("pdfTokenEstimate", () => {
  it("returns a bounded estimate from the payload size", () => {
    expect(pdfTokenEstimate(DATA_URL)).toBeGreaterThanOrEqual(500);
    expect(pdfTokenEstimate(DATA_URL)).toBeLessThanOrEqual(8000);
    expect(pdfTokenEstimate("")).toBe(2000);
  });
});
