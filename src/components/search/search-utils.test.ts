/**
 * Unit tests for search-panel pure logic (search-utils.ts).
 *
 *  - filterSearchResults: type ("tasks" → card) + project filtering.
 *  - resolveFocusedResult / clampFocus: the two-list (notes then tasks)
 *    keyboard-nav index translation — the classic subtle off-by-one on the
 *    notes/tasks boundary.
 *  - mergeSemanticResults: append-only dedupe of semantic hits over keyword hits.
 */

import { describe, it, expect } from "vitest";
import {
  filterSearchResults,
  resolveFocusedResult,
  clampFocus,
  mergeSemanticResults,
} from "./search-utils";
import type { SearchResult } from "@/store";

const r = (id: string, type: "note" | "card", projectId = "p1"): SearchResult => ({
  type,
  id,
  title: id,
  snippet: "",
  projectId,
  projectName: projectId,
});

describe("filterSearchResults", () => {
  const results = [r("n1", "note"), r("c1", "card"), r("n2", "note", "p2")];

  it("returns everything for 'all' with no project filter", () => {
    expect(filterSearchResults(results, "all", null)).toHaveLength(3);
  });

  it("keeps only notes for 'notes'", () => {
    const out = filterSearchResults(results, "notes", null);
    expect(out.map((x) => x.id)).toEqual(["n1", "n2"]);
  });

  it("maps the 'tasks' tab to card-type results", () => {
    const out = filterSearchResults(results, "tasks", null);
    expect(out.map((x) => x.id)).toEqual(["c1"]);
  });

  it("applies the project filter on top of the type filter", () => {
    expect(filterSearchResults(results, "all", "p2").map((x) => x.id)).toEqual(["n2"]);
    expect(filterSearchResults(results, "notes", "p1").map((x) => x.id)).toEqual(["n1"]);
  });
});

describe("resolveFocusedResult", () => {
  const notes = [r("n1", "note"), r("n2", "note")];
  const tasks = [r("c1", "card"), r("c2", "card")];

  it("resolves indices within the notes range", () => {
    expect(resolveFocusedResult(0, notes, tasks)?.id).toBe("n1");
    expect(resolveFocusedResult(1, notes, tasks)?.id).toBe("n2");
  });

  it("translates indices past the notes into the tasks list", () => {
    expect(resolveFocusedResult(2, notes, tasks)?.id).toBe("c1");
    expect(resolveFocusedResult(3, notes, tasks)?.id).toBe("c2");
  });

  it("returns null for out-of-range or negative indices", () => {
    expect(resolveFocusedResult(4, notes, tasks)).toBeNull();
    expect(resolveFocusedResult(-1, notes, tasks)).toBeNull();
  });

  it("handles an empty notes list (all focus maps to tasks)", () => {
    expect(resolveFocusedResult(0, [], tasks)?.id).toBe("c1");
  });
});

describe("clampFocus", () => {
  it("clamps within [0, total-1]", () => {
    expect(clampFocus(-5, 3)).toBe(0);
    expect(clampFocus(10, 3)).toBe(2);
    expect(clampFocus(1, 3)).toBe(1);
  });

  it("returns 0 when there are no results", () => {
    expect(clampFocus(5, 0)).toBe(0);
  });
});

describe("mergeSemanticResults", () => {
  it("appends only semantic hits not already present by id", () => {
    const keyword = [r("a", "note"), r("b", "note")];
    const semantic = [r("b", "note"), r("c", "note")]; // b is a dup
    const merged = mergeSemanticResults(keyword, semantic);
    expect(merged.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves keyword order and position (keyword wins)", () => {
    const keyword = [r("a", "note")];
    const semantic = [r("a", "card"), r("z", "note")];
    const merged = mergeSemanticResults(keyword, semantic);
    // 'a' keeps its keyword entry (type note), only 'z' is appended.
    expect(merged.map((x) => `${x.id}:${x.type}`)).toEqual(["a:note", "z:note"]);
  });

  it("returns the keyword list unchanged when there are no semantic hits", () => {
    const keyword = [r("a", "note")];
    expect(mergeSemanticResults(keyword, [])).toEqual(keyword);
  });

  it("dedupes repeated semantic hits against each other", () => {
    // Two semantic hits share id "c"; only the first should be appended.
    const keyword = [r("a", "note")];
    const semantic = [r("c", "note"), r("c", "note"), r("d", "note")];
    const merged = mergeSemanticResults(keyword, semantic);
    expect(merged.map((x) => x.id)).toEqual(["a", "c", "d"]);
  });
});
