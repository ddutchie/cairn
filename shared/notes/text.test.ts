import { describe, it, expect } from "vitest";
import { stripMarkdown, queryTerms, matchesQuery } from "./text";

describe("queryTerms", () => {
  it("splits on whitespace and lowercases", () => {
    expect(queryTerms("Auth Flow")).toEqual(["auth", "flow"]);
    expect(queryTerms("  multiple   spaces ")).toEqual(["multiple", "spaces"]);
  });
  it("returns [] for empty/whitespace", () => {
    expect(queryTerms("")).toEqual([]);
    expect(queryTerms("   ")).toEqual([]);
  });
});

describe("matchesQuery — AND-of-terms", () => {
  it("matches when every term appears somewhere (order-independent)", () => {
    // The whole point: multi-word queries no longer require the exact phrase.
    expect(matchesQuery("auth flow", "Authentication flow diagram")).toBe(true);
    expect(matchesQuery("auth flow", "the flow for auth")).toBe(true);
    expect(matchesQuery("flow auth", "Authentication flow")).toBe(true);
  });

  it("does not match when any term is absent", () => {
    expect(matchesQuery("auth flow", "Authentication only")).toBe(false);
    expect(matchesQuery("login bug", "login screen works fine")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(matchesQuery("AUTH", "authentication")).toBe(true);
    expect(matchesQuery("auth", "AUTHENTICATION")).toBe(true);
  });

  it("matches mid-word substrings per term", () => {
    expect(matchesQuery("uth", "authentication")).toBe(true);
  });

  it("single-term query behaves like a substring match", () => {
    expect(matchesQuery("meeting", "Notes from the meeting")).toBe(true);
    expect(matchesQuery("meeting", "standup")).toBe(false);
  });

  it("empty query matches nothing", () => {
    expect(matchesQuery("", "anything")).toBe(false);
    expect(matchesQuery("   ", "anything")).toBe(false);
  });

  it("terms can span title and body when the haystack is combined", () => {
    const hay = "Login pipeline\ncovers token refresh and errors";
    expect(matchesQuery("login refresh", hay)).toBe(true); // one term in title, one in body
  });
});

describe("stripMarkdown", () => {
  it("removes markdown punctuation without merging words", () => {
    expect(stripMarkdown("[a](b)c")).not.toContain("abc");
  });
  it("returns empty string for empty input", () => {
    expect(stripMarkdown("")).toBe("");
  });
});
