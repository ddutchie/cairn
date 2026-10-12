import { describe, it, expect } from "vitest";
import {
  preprocessCairnMarkdown,
  noteTitleFromUrl,
  embedNameFromUrl,
  splitLeadingTitleHeading,
  cardIdFromUrl,
  CAIRN_NOTE_SCHEME,
  CAIRN_CARD_SCHEME,
  type WikilinkResolver,
} from "./markdown";

describe("preprocessCairnMarkdown — wikilinks", () => {
  it("encodes the title into a note URL when no resolver is given", () => {
    expect(preprocessCairnMarkdown("see [[My Note]] now")).toBe(
      `see [My Note](${CAIRN_NOTE_SCHEME}My%20Note) now`,
    );
  });

  it("bakes a note id into the URL when the resolver matches a note", () => {
    const resolve: WikilinkResolver = (t) => (t === "My Note" ? { kind: "note", id: "n1" } : null);
    expect(preprocessCairnMarkdown("[[My Note]]", resolve)).toBe(`[My Note](${CAIRN_NOTE_SCHEME}n1)`);
  });

  it("bakes a card id into the task URL when the resolver matches a card", () => {
    const resolve: WikilinkResolver = (t) => (t === "Fix bug" ? { kind: "card", id: "c9" } : null);
    expect(preprocessCairnMarkdown("[[Fix bug]]", resolve)).toBe(`[Fix bug](${CAIRN_CARD_SCHEME}c9)`);
  });

  it("uses the resolver's canonical title as the label when provided", () => {
    const resolve: WikilinkResolver = () => ({ kind: "note", id: "n1", title: "Canonical" });
    expect(preprocessCairnMarkdown("[[canonical]]", resolve)).toBe(`[Canonical](${CAIRN_NOTE_SCHEME}n1)`);
  });

  it("falls back to a title-encoded note URL when the resolver returns null", () => {
    const resolve: WikilinkResolver = () => null;
    expect(preprocessCairnMarkdown("[[Ghost]]", resolve)).toBe(`[Ghost](${CAIRN_NOTE_SCHEME}Ghost)`);
  });

  it("encodes ids that contain URL-sensitive characters", () => {
    const resolve: WikilinkResolver = () => ({ kind: "card", id: "a/b?c" });
    expect(preprocessCairnMarkdown("[[x]]", resolve)).toBe(`[x](${CAIRN_CARD_SCHEME}a%2Fb%3Fc)`);
  });

  it("trims whitespace inside the wikilink before resolving", () => {
    const seen: string[] = [];
    const resolve: WikilinkResolver = (t) => {
      seen.push(t);
      return null;
    };
    preprocessCairnMarkdown("[[  Spaced  ]]", resolve);
    expect(seen).toEqual(["Spaced"]);
  });

  it("keeps embeds winning over wikilinks (the ! prefix)", () => {
    expect(preprocessCairnMarkdown("![[pic.png]]")).toBe("_(embed: pic.png)_");
  });

  it("returns empty string for empty input", () => {
    expect(preprocessCairnMarkdown("")).toBe("");
  });
});

describe("noteTitleFromUrl / cardIdFromUrl", () => {
  it("decodes a note URL", () => {
    expect(noteTitleFromUrl(`${CAIRN_NOTE_SCHEME}My%20Note`)).toBe("My Note");
  });

  it("returns null for a card URL from the note decoder", () => {
    expect(noteTitleFromUrl(`${CAIRN_CARD_SCHEME}c1`)).toBeNull();
  });

  it("decodes a card URL", () => {
    expect(cardIdFromUrl(`${CAIRN_CARD_SCHEME}a%2Fb`)).toBe("a/b");
  });

  it("returns null for a note URL from the card decoder", () => {
    expect(cardIdFromUrl(`${CAIRN_NOTE_SCHEME}n1`)).toBeNull();
  });

  it("returns null for an external URL", () => {
    expect(noteTitleFromUrl("https://example.com")).toBeNull();
    expect(cardIdFromUrl("https://example.com")).toBeNull();
  });
});

describe("preprocessCairnMarkdown image embeds", () => {
  it("keeps the placeholder for embeds by default", () => {
    expect(preprocessCairnMarkdown("![[a b.png]]")).toBe("_(embed: a b.png)_");
  });

  it("rewrites image embeds to a resolvable cairn://embed/ image when asked", () => {
    const out = preprocessCairnMarkdown("see ![[my pic.png|300]] ok", undefined, { imageEmbeds: true });
    expect(out).toBe("see ![my pic.png](cairn://embed/my%20pic.png) ok");
  });

  it("leaves non-image embeds (pdf, notes) as placeholders", () => {
    expect(preprocessCairnMarkdown("![[doc.pdf]]", undefined, { imageEmbeds: true })).toBe("_(embed: doc.pdf)_");
  });

  it("round-trips the embed name through embedNameFromUrl", () => {
    expect(embedNameFromUrl("cairn://embed/my%20pic.png")).toBe("my pic.png");
    expect(embedNameFromUrl("https://x/y.png")).toBeNull();
  });
});

describe("splitLeadingTitleHeading", () => {
  it("removes an H1 that repeats the title, plus the blank lines after it", () => {
    const r = splitLeadingTitleHeading("# My Note\n\nbody text\n", "My Note");
    expect(r.body).toBe("body text\n");
    expect(r.prefix + r.body).toBe("# My Note\n\nbody text\n");
  });

  it("matches case-insensitively and ignores closing hashes / leading blank lines", () => {
    expect(splitLeadingTitleHeading("\n# my note ##\ntext", "My Note").body).toBe("text");
  });

  it("keeps a different heading, a deeper heading, or a heading that is not first", () => {
    expect(splitLeadingTitleHeading("# Other\ntext", "My Note").prefix).toBe("");
    expect(splitLeadingTitleHeading("## My Note\ntext", "My Note").prefix).toBe("");
    expect(splitLeadingTitleHeading("intro\n# My Note\n", "My Note").prefix).toBe("");
  });

  it("handles a title-only note and missing input", () => {
    expect(splitLeadingTitleHeading("# My Note", "My Note")).toEqual({ prefix: "# My Note", body: "" });
    expect(splitLeadingTitleHeading(null, "x")).toEqual({ prefix: "", body: "" });
    expect(splitLeadingTitleHeading("# x\ny", "")).toEqual({ prefix: "", body: "# x\ny" });
  });
});
