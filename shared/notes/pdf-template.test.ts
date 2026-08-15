import { describe, it, expect } from "vitest";
import { buildPdfHtml, buildPdfFooterTemplate, buildPdfHeaderTemplate, pdfSafeFilename, escapeHtmlText, DEFAULT_PDF_FONT_FAMILY } from "./pdf-template";

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

  it("omits the in-body title heading when titleMode is 'none'", () => {
    const html = buildPdfHtml("My Title", "<p>hi</p>", "light", "none");
    expect(html).toContain("<title>My Title</title>"); // document <title> still set
    expect(html).not.toContain('class="pdf-title"'); // but no in-body heading
    expect(html).toContain('<div class="prose-cairn"><p>hi</p></div>');
  });

  it("escapes < in the title to prevent injection", () => {
    const html = buildPdfHtml("a<b", "", "light");
    expect(html).toContain("a&lt;b");
  });

  it("escapes & in both the document <title> and the in-body heading", () => {
    const html = buildPdfHtml("Tom & Jerry <x>", "", "light");
    expect(html).toContain("<title>Tom &amp; Jerry &lt;x&gt;</title>");
    expect(html).toContain('class="pdf-title">Tom &amp; Jerry &lt;x&gt;</h1>');
  });

  it("applies dark theme background when theme=dark", () => {
    const html = buildPdfHtml("T", "", "dark");
    expect(html).toContain("#141414"); // DARK_VARS.bg
  });

  it("defaults the body font to the platform sans stack", () => {
    const html = buildPdfHtml("T", "<p>hi</p>", "light");
    expect(html).toContain(`font-family: ${DEFAULT_PDF_FONT_FAMILY}`);
  });

  it("uses the provided font family for the note body", () => {
    const html = buildPdfHtml("T", "<p>hi</p>", "light", "none", 'Georgia, serif');
    expect(html).toContain("font-family: Georgia, serif");
    expect(html).not.toContain(`font-family: ${DEFAULT_PDF_FONT_FAMILY}`);
  });
});

describe("buildPdfFooterTemplate", () => {
  it("renders the title on the left and page numbers on the right", () => {
    const footer = buildPdfFooterTemplate("My Title");
    expect(footer).toContain("My Title");
    expect(footer).toContain('class="pageNumber"');
    expect(footer).toContain('class="totalPages"');
  });

  it("escapes < and & in the title to prevent injection", () => {
    const footer = buildPdfFooterTemplate("a<b&c");
    expect(footer).toContain("a&lt;b&amp;c");
  });

  it("uses the dark secondary colour when theme=dark", () => {
    expect(buildPdfFooterTemplate("T", "dark")).toContain("#9e9a94"); // DARK_VARS.textSecondary
  });

  it("sets border-box sizing so padding stays inside the page width", () => {
    expect(buildPdfFooterTemplate("T")).toContain("box-sizing:border-box");
  });

  it("defaults the footer font to the platform sans stack", () => {
    expect(buildPdfFooterTemplate("T")).toContain(DEFAULT_PDF_FONT_FAMILY);
  });

  it("uses the provided font family in the footer", () => {
    expect(buildPdfFooterTemplate("T", "light", "Georgia, serif")).toContain("font-family:Georgia, serif");
  });
});

describe("escapeHtmlText", () => {
  it("escapes &, <, and > in text-context order (& first, no double-escape)", () => {
    expect(escapeHtmlText("Tom & Jerry <x>")).toBe("Tom &amp; Jerry &lt;x&gt;");
    expect(escapeHtmlText("&lt;")).toBe("&amp;lt;"); // literal &lt; is escaped, not treated as an entity
  });

  it("handles nullish input", () => {
    expect(escapeHtmlText(undefined as unknown as string)).toBe("");
  });
});

describe("buildPdfHeaderTemplate", () => {
  it("returns a minimal empty header", () => {
    expect(buildPdfHeaderTemplate()).toBe("<div></div>");
  });
});
