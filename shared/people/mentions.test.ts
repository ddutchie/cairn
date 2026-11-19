import { describe, expect, it } from "vitest";
import type { Person } from "../types/people";
import { chosenInText, findMentions, matchPeople, trailingMention } from "./mentions";

const person = (id: string, name: string, aliases: string[] = []): Person => ({ id, name, aliases } as Person);
const ana = person("p1", "Ana Lopez", ["Ana"]);
const anabel = person("p2", "Anabel");
const chris1 = person("p3", "Chris");
const chris2 = person("p4", "Chris", []);

describe("findMentions", () => {
  it("matches a name or alias, ignoring case and accents", () => {
    expect(findMentions("ask @ana lópez about it", [ana]).matched.map((p) => p.id)).toEqual(["p1"]);
    expect(findMentions("@Ana: thoughts?", [ana]).matched.map((p) => p.id)).toEqual(["p1"]);
  });
  it("does not match inside a longer name", () => {
    expect(findMentions("hi @Anabel", [ana, anabel]).matched.map((p) => p.id)).toEqual(["p2"]);
  });
  it("ignores email addresses and unknown names", () => {
    expect(findMentions("mail ana@example.com or @Zed", [ana]).matched).toEqual([]);
  });
  it("reports a shared name as ambiguous", () => {
    const r = findMentions("@Chris is late", [chris1, chris2]);
    expect(r.matched).toEqual([]);
    expect(r.ambiguous[0].people.map((p) => p.id)).toEqual(["p3", "p4"]);
  });
  it("lists each person once", () => {
    expect(findMentions("@Ana and @Ana Lopez", [ana]).matched).toHaveLength(1);
  });
});

describe("findMentions boundaries and identity", () => {
  const jose = person("p9", "Jose");
  it("treats combining accents as part of the word", () => {
    expect(findMentions("@Jose\u0301ph", [jose]).matched).toEqual([]);
    expect(findMentions("@Joséph", [jose]).matched).toEqual([]);
    expect(findMentions("@Jose\u0301 hi", [jose]).matched).toHaveLength(1);
    expect(findMentions("@Jose hi", [jose]).matched).toHaveLength(1);
  });
  it("resolves names longer than 60 characters", () => {
    const name = "Alexandria ".repeat(6).trim();
    expect(name.length).toBeGreaterThan(60);
    expect(findMentions(`@${name} hi`, [person("p8", name)]).matched).toHaveLength(1);
  });
  it("uses the picked person for a shared name", () => {
    const r = findMentions("@Chris said", [chris1, chris2], new Map([["chris", "p4"]]));
    expect(r.matched.map((p) => p.id)).toEqual(["p4"]);
    expect(r.ambiguous).toEqual([]);
  });
});

describe("trailingMention", () => {
  it("finds the @query at the end of the draft", () => {
    expect(trailingMention("hi @An")).toEqual({ query: "An", start: 3 });
    expect(trailingMention("@Ana Lo")).toEqual({ query: "Ana Lo", start: 0 });
  });
  it("ignores emails and finished mentions elsewhere", () => {
    expect(trailingMention("mail a@b.com")).toBeNull();
    expect(trailingMention("@Ana said hi\nnext")).toBeNull();
  });
});

describe("matchPeople", () => {
  it("ranks prefix matches first and matches aliases", () => {
    const names = matchPeople([anabel, ana, chris1], "an").map((p) => p.name);
    expect(names).toEqual(["Anabel", "Ana Lopez"]);
    expect(matchPeople([ana], "Ana")[0].name).toBe("Ana Lopez");
    expect(matchPeople([chris1], "zz")).toEqual([]);
  });
  it("lists everyone for a bare @", () => {
    expect(matchPeople([ana, chris1], "")).toHaveLength(2);
  });
});

describe("chosenInText", () => {
  const picks = new Map([["alex kim", "p1"]]);
  it("keeps a pick while its mention is in the text", () => {
    expect([...chosenInText("ask @Alex Kim about it", picks)]).toEqual([["alex kim", "p1"]]);
  });
  it("drops a pick once the mention is deleted or edited", () => {
    expect(chosenInText("ask about it", picks).size).toBe(0);
    expect(chosenInText("ask @Alex Kimberly", picks).size).toBe(0);
    expect(chosenInText("mail alex@kim.com", picks).size).toBe(0);
  });
  it("a dropped pick leaves a typed shared name ambiguous", () => {
    const two = [person("p1", "Alex Kim"), person("p2", "Alex Kim")];
    const text = "@Alex Kim again";
    expect(findMentions(text, two, chosenInText("different text", picks)).ambiguous).toHaveLength(1);
    expect(findMentions(text, two, chosenInText(text, picks)).matched.map((p) => p.id)).toEqual(["p1"]);
  });
});
