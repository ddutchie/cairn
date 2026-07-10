import { describe, it, expect } from "vitest";
import {
  preprocessCairnMarkdown,
  noteTitleFromUrl,
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
