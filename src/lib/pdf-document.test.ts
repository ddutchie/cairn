/**
 * Unit tests for the desktop PDF document loader, using the committed test
 * fixture (a 4-page PDF rendered from the markdown-parity spec).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataUrlToBytes, pdfPageCount } from "./pdf-document";

const FIXTURE = path.join(__dirname, "__fixtures__", "markdown-parity-test.pdf");

function fixtureDataUrl(): string {
  return `data:application/pdf;base64,${fs.readFileSync(FIXTURE).toString("base64")}`;
}

describe("pdf-document", () => {
  it("reads the committed 4-page fixture", async () => {
    await expect(pdfPageCount(fixtureDataUrl())).resolves.toBe(4);
  });

  it("decodes a data URL to bytes", () => {
    const bytes = dataUrlToBytes("data:application/pdf;base64,SGVsbG8=");
    expect(Buffer.from(bytes).toString("utf8")).toBe("Hello");
  });

  it("treats a non-URL string as raw base64", () => {
    const bytes = dataUrlToBytes("SGVsbG8=");
    expect(Buffer.from(bytes).toString("utf8")).toBe("Hello");
  });

  it("rejects junk input", async () => {
    await expect(pdfPageCount("data:application/pdf;base64,bm90IGEgcGRm")).rejects.toThrow();
  });
});
