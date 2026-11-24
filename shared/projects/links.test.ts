import { describe, it, expect } from "vitest";
import {
  addProjectLinks, buildProjectLink, detectProjectLink, extractLinkCandidates,
  normalizeLinks, normalizeLinkUrl, removeProjectLinks,
} from "./links";

let n = 0;
const id = () => `l${++n}`;

describe("detectProjectLink", () => {
  it.each([
    ["https://acme.atlassian.net/wiki/spaces/ENG/overview", "confluence", "ENG"],
    ["https://acme.atlassian.net/browse/PAY-123", "jira", "PAY"],
    ["https://acme.atlassian.net/jira/software/projects/OPS/boards/1", "jira", "OPS"],
    ["https://acme.slack.com/archives/C0123ABC", "slack", "C0123ABC"],
    ["https://app.slack.com/client/T1/C99", "slack", "C99"],
    ["https://github.com/acme/widgets.git", "github", "acme/widgets"],
    ["https://linear.app/acme/team/CORE/active", "linear", "CORE"],
    ["https://www.figma.com/file/abc", "figma", undefined],
    ["https://example.com/page", "url", undefined],
  ])("%s", (url, kind, ref) => {
    const d = detectProjectLink(url)!;
    expect(d.kind).toBe(kind);
    expect(d.ref).toBe(ref);
  });

  it("does not treat a bare /jira path as a project", () => {
    expect(detectProjectLink("https://acme.atlassian.net/jira/dashboards")!.ref).toBeUndefined();
  });

  it("refuses non-http schemes", () => {
    expect(detectProjectLink("javascript:alert(1)")).toBeNull();
    expect(detectProjectLink("file:///etc/passwd")).toBeNull();
    expect(detectProjectLink("")).toBeNull();
  });

  it("accepts a bare host", () => {
    expect(normalizeLinkUrl("example.com/a/")).toBe("https://example.com/a");
  });
});

describe("addProjectLinks", () => {
  it("fills kind, label and ref from the URL", () => {
    const { links } = addProjectLinks([], [{ url: "https://acme.atlassian.net/wiki/spaces/ENG/x" }], id);
    expect(links[0]).toMatchObject({ kind: "confluence", ref: "ENG", label: "Confluence space ENG" });
  });

  it("is keyed by URL: repeating updates in place and keeps the id", () => {
    const first = addProjectLinks([], [{ url: "https://acme.slack.com/archives/C1/", label: "alerts" }], id).links;
    const second = addProjectLinks(first, [{ url: "https://acme.slack.com/archives/C1#x", note: "on-call" }], id);
    expect(second.links).toHaveLength(1);
    expect(second.links[0]).toMatchObject({ id: first[0].id, label: "alerts", note: "on-call", ref: "C1" });
  });

  it("rejects bad URLs and reports them", () => {
    const r = addProjectLinks([], [{ url: "javascript:x" }, { url: "https://ok.example.com" }], id);
    expect(r.links).toHaveLength(1);
    expect(r.rejected).toEqual(["javascript:x"]);
  });

  it("stops at the limit", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ url: `https://e.com/${i}` }));
    const r = addProjectLinks([], many, id);
    expect(r.links).toHaveLength(50);
    expect(r.rejected).toHaveLength(10);
  });

  it("an explicit kind drops the detected ref and uses the kind's label", () => {
    const l = buildProjectLink({ url: "https://acme.slack.com/archives/C1", kind: "url" }, "x")!;
    expect(l).toMatchObject({ kind: "url", label: "Link" });
    expect(l.ref).toBeUndefined();
  });
});

describe("normalizeLinks / removeProjectLinks", () => {
  it("drops malformed and duplicate rows", () => {
    const out = normalizeLinks([
      { id: "a", url: "https://e.com/x" },
      { id: "b", url: "https://e.com/x/" },
      { id: "c", url: "javascript:1" },
      { url: "https://e.com/y" },
      "junk",
    ]);
    expect(out.map((l) => l.id)).toEqual(["a"]);
    expect(normalizeLinks("nope")).toEqual([]);
  });

  it("removes by id", () => {
    const links = normalizeLinks([{ id: "a", url: "https://e.com/a" }, { id: "b", url: "https://e.com/b" }]);
    expect(removeProjectLinks(links, ["a"]).map((l) => l.id)).toEqual(["b"]);
  });
});

describe("extractLinkCandidates", () => {
  it("finds URLs in prose, trims punctuation, skips ones already linked", () => {
    const existing = normalizeLinks([{ id: "a", url: "https://e.com/have" }]);
    const found = extractLinkCandidates("Docs: https://e.com/new, and https://e.com/have. See (https://e.com/new).", existing);
    expect(found.map((f) => f.url)).toEqual(["https://e.com/new"]);
  });
});
