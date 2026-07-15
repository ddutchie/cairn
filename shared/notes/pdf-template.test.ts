import { describe, it, expect } from "vitest";
import { buildPdfHtml, pdfSafeFilename } from "./pdf-template";

describe("pdfSafeFilename", () => {
  it("strips filesystem-illegal characters, replacing them with underscore", () => {
    expect(pdfSafeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  it("trims surrounding whitespace", () => {
    expect(pdfSafeFilename("  My Note  ")).toBe("My Note");
  });

  it("keeps ordinary titles (incl. unicode) intact", () => {
    expect(pdfSafeFilename("Weekly Review — 2026")).toBe("Weekly Review — 2026");
  });

  it("falls back to 'untitled' when nothing usable remains", () => {
    expect(pdfSafeFilename("")).toBe("untitled");
    expect(pdfSafeFilename("   ")).toBe("untitled");
    expect(pdfSafeFilename("///")).toBe("___"); // slashes become underscores, not empty
    expect(pdfSafeFilename(undefined as unknown as string)).toBe("untitled");
  });
});

describe("buildPdfHtml", () => {
  it("wraps the body in a self-contained document with the title", () => {
    const html = buildPdfHtml("My Title", "<p>hi</p>", "light");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>My Title</title>");
    expect(html).toContain('class="pdf-title">My Title</h1>');
    expect(html).toContain('<div class="prose-cairn"><p>hi</p></div>');
  });

  it("escapes < in the title to prevent injection", () => {
    const html = buildPdfHtml("a<b", "", "light");
    expect(html).toContain("a&lt;b");
  });

  it("applies dark theme background when theme=dark", () => {
    const html = buildPdfHtml("T", "", "dark");
    expect(html).toContain("#141414"); // DARK_VARS.bg
  });
});
