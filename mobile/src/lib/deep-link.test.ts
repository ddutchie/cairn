import { describe, it, expect } from "vitest";
import { redirectDetailLink } from "./deep-link";

describe("redirectDetailLink", () => {
  it("pins widget project links to the Projects tab", () => {
    expect(redirectDetailLink("cairn://project/abc")).toBe("/(projects)/project/abc");
    expect(redirectDetailLink("/project/abc")).toBe("/(projects)/project/abc");
  });
  it("still treats ids that merely start with new as details", () => {
    expect(redirectDetailLink("/card/newton")).toBe("/(projects)/card/newton");
  });
  it("pins note and task links too, keeping the query", () => {
    expect(redirectDetailLink("cairn://note/n1?x=1")).toBe("/(projects)/note/n1?x=1");
    expect(redirectDetailLink("/card/c1")).toBe("/(projects)/card/c1");
  });
  it("leaves every other link alone", () => {
    for (const p of [
      "cairn://card/new?project=p1",
      "/note/new?project=p1","cairn://projects", "cairn://capture?text=hi", "cairn://oauth/callback?code=1", "/search", "/workspace/people", "/(projects)/project/abc"]) {
      expect(redirectDetailLink(p)).toBe(p);
    }
  });
});
