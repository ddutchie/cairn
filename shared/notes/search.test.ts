import { describe, expect, it } from "vitest";
import { buildSnippet, findMatches, matchesParsed, parseSearchQuery } from "./search";
import { matchesQuery } from "./text";

describe("parseSearchQuery", () => {
  it("splits terms, phrases and exclusions", () => {
    expect(parseSearchQuery('Auth "login flow" -draft -"old api"')).toEqual({
      include: ["auth", "login flow"],
      exclude: ["draft", "old api"],
    });
  });
  it("ignores a lone dash and empty phrases", () => {
    expect(parseSearchQuery('- "" foo')).toEqual({ include: ["foo"], exclude: [] });
  });
  it("an unbalanced quote falls back to plain terms", () => {
    expect(parseSearchQuery('"foo bar').include).toEqual(['"foo', "bar"]);
  });
});

describe("matchesQuery / matchesParsed", () => {
  it("keeps AND-of-terms behaviour for plain queries", () => {
    expect(matchesQuery("auth flow", "flow for Authentication")).toBe(true);
  });
  it("phrases must be contiguous", () => {
    expect(matchesQuery('"auth flow"', "flow for auth")).toBe(false);
    expect(matchesQuery('"auth flow"', "the auth flow works")).toBe(true);
  });
  it("exclusions reject, exclude-only matches nothing", () => {
    expect(matchesQuery("auth -draft", "auth draft")).toBe(false);
    expect(matchesQuery("-draft", "anything")).toBe(false);
    expect(matchesParsed({ include: [], exclude: [] }, "x")).toBe(false);
  });
});

describe("buildSnippet", () => {
  const body = "intro ".repeat(30) + "the Needle is here\nand more text " + "tail ".repeat(30);
  it("centres on the first match with aligned highlight ranges", () => {
    const s = buildSnippet(body, ["needle"])!;
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.term).toBe("needle");
    expect(s.count).toBe(1);
    expect(s.line).toBe(1);
    const [a, b] = s.ranges[0];
    expect(s.text.slice(a, b)).toBe("Needle");
    expect(s.text).not.toContain("\n");
  });
  it("returns null with no body match", () => {
    expect(buildSnippet("nothing", ["zzz"])).toBeNull();
  });
  it("highlights every term in the excerpt", () => {
    const s = buildSnippet("alpha beta gamma", ["alpha", "gamma"])!;
    expect(s.ranges.map(([a, b]) => s.text.slice(a, b))).toEqual(["alpha", "gamma"]);
  });
});

describe("findMatches", () => {
  it("is case-insensitive by default and escapes regex chars", () => {
    expect(findMatches("a.b A.B axb", "a.b")).toEqual([{ from: 0, to: 3 }, { from: 4, to: 7 }]);
  });
  it("supports case-sensitive and whole-word", () => {
    expect(findMatches("Cat cat concat", "cat", { caseSensitive: true })).toHaveLength(2);
    expect(findMatches("Cat cat concat", "cat", { wholeWord: true })).toHaveLength(2);
  });
});
