import { describe, it, expect } from "vitest";
import { extractExternalRef, extractExternalRefs, isHttpUrl } from "./external-ref";

const j = (o: unknown) => JSON.stringify(o);

describe("extractExternalRef — single result", () => {
  it("returns undefined for empty/undefined/non-JSON-without-url", () => {
    expect(extractExternalRef(undefined)).toBeUndefined();
    expect(extractExternalRef("")).toBeUndefined();
    expect(extractExternalRef("just some plain text")).toBeUndefined();
  });

  it("ignores a Cairn error object", () => {
    expect(extractExternalRef(j({ error: "Tool failed: 404" }))).toBeUndefined();
  });

  it("prefers html_url over a bare url (GitHub shape)", () => {
    const ref = extractExternalRef(j({ url: "https://api.github.com/repos/x/y/pulls/1", html_url: "https://github.com/x/y/pull/1", title: "Fix bug" }));
    expect(ref).toEqual({ url: "https://github.com/x/y/pull/1", title: "Fix bug", snippet: undefined });
  });

  it("extracts url + title + snippet (web search hit shape)", () => {
    const ref = extractExternalRef(j({ title: "Result", url: "https://example.com/a", snippet: "A description here" }));
    expect(ref?.url).toBe("https://example.com/a");
    expect(ref?.title).toBe("Result");
    expect(ref?.snippet).toBe("A description here");
  });

  it("handles Atlassian/Confluence _links.webui", () => {
    const ref = extractExternalRef(j({ title: "My Page", _links: { webui: "https://acme.atlassian.net/wiki/spaces/X/pages/123", self: "https://acme.atlassian.net/wiki/rest/api/content/123" } }));
    expect(ref?.url).toBe("https://acme.atlassian.net/wiki/spaces/X/pages/123");
    expect(ref?.title).toBe("My Page");
  });

  it("falls back to self when it's the only link (Jira REST)", () => {
    const ref = extractExternalRef(j({ key: "PROJ-1", self: "https://acme.atlassian.net/rest/api/2/issue/1000", summary: "Ticket" }));
    expect(ref?.url).toBe("https://acme.atlassian.net/rest/api/2/issue/1000");
    expect(ref?.title).toBe("Ticket"); // summary → title
  });

  it("reaches into a results[] list and returns the first hit", () => {
    const ref = extractExternalRef(j({ results: [ { name: "First", url: "https://a.com" }, { name: "Second", url: "https://b.com" } ] }));
    expect(ref?.url).toBe("https://a.com");
    expect(ref?.title).toBe("First");
  });

  it("rejects non-http(s) URLs (javascript:/data:/file:)", () => {
    expect(extractExternalRef(j({ url: "javascript:alert(1)", title: "x" }))).toBeUndefined();
    expect(extractExternalRef(j({ url: "data:text/html,<b>", title: "x" }))).toBeUndefined();
    expect(extractExternalRef(j({ url: "file:///etc/passwd" }))).toBeUndefined();
  });

  it("pulls a bare https URL out of plain-text output", () => {
    const ref = extractExternalRef("See https://example.com/page for details.");
    expect(ref?.url).toBe("https://example.com/page");
  });

  it("strips trailing punctuation from a loose-text URL", () => {
    const ref = extractExternalRef("Source: https://example.com/x.");
    expect(ref?.url).toBe("https://example.com/x");
  });

  it("truncates long snippets to ~160 chars", () => {
    const long = "x".repeat(300);
    const ref = extractExternalRef(j({ url: "https://a.com", description: long }));
    expect(ref?.snippet?.length).toBeLessThanOrEqual(160);
    expect(ref?.snippet?.endsWith("…")).toBe(true);
  });

  it("returns undefined when a deeply nested payload has no URL at all", () => {
    expect(extractExternalRef(j({ a: { b: { c: { count: 5, ok: true } } } }))).toBeUndefined();
  });
});

describe("extractExternalRefs — list results", () => {
  it("returns up to N unique refs from a results list", () => {
    const refs = extractExternalRefs(j({ results: [
      { title: "A", url: "https://a.com" },
      { title: "B", url: "https://b.com" },
      { title: "C", url: "https://c.com" },
      { title: "D", url: "https://d.com" },
    ] }), 3);
    expect(refs.map((r) => r.url)).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
  });

  it("dedupes repeated URLs", () => {
    const refs = extractExternalRefs(j({ items: [ { url: "https://a.com" }, { url: "https://a.com" }, { url: "https://b.com" } ] }), 5);
    expect(refs.map((r) => r.url)).toEqual(["https://a.com", "https://b.com"]);
  });

  it("falls back to the single ref for a non-list object", () => {
    const refs = extractExternalRefs(j({ url: "https://only.com", title: "One" }));
    expect(refs).toEqual([{ url: "https://only.com", title: "One", snippet: undefined }]);
  });

  it("returns [] when nothing linkable", () => {
    expect(extractExternalRefs(j({ ok: true }))).toEqual([]);
    expect(extractExternalRefs(undefined)).toEqual([]);
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https only", () => {
    expect(isHttpUrl("https://x.com")).toBe(true);
    expect(isHttpUrl("http://x.com")).toBe(true);
    expect(isHttpUrl("ftp://x.com")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});
