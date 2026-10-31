import { describe, it, expect } from "vitest";
import { bm25Scores, ftsOrQuery, hybridRank, queryTerms, termCoverage, type RetrievalCandidate } from "./hybrid";

const c = (id: string, o: Partial<RetrievalCandidate> = {}): RetrievalCandidate => ({ id, ...o });

describe("query helpers", () => {
  it("drops stopwords and keeps id-like short tokens", () => {
    expect(queryTerms("How does the v2 sync work?")).toEqual(["v2", "sync"]);
    expect(queryTerms("ERR-4021")).toEqual(["err", "4021"]);
  });
  it("builds an OR prefix FTS expression and escapes quotes", () => {
    expect(ftsOrQuery("semantic search")).toBe('"semantic"* OR "search"*');
    expect(ftsOrQuery("the and")).toBe("");
  });
  it("measures coverage by substring", () => {
    expect(termCoverage(["auth", "flow"], "Authentication", "flow chart")).toBe(1);
    expect(termCoverage(["auth", "flow"], "x", "y")).toBe(0);
  });
});

describe("bm25Scores", () => {
  it("scores rarer terms and title hits higher, 0 for no match", () => {
    const s = bm25Scores(["ingress"], [
      { title: "Kubernetes ingress", text: "setup" },
      { title: "Notes", text: "ingress mentioned once among many other words here" },
      { title: "Garden", text: "water" },
    ]);
    expect(s[0]).toBeGreaterThan(s[1]);
    expect(s[1]).toBeGreaterThan(0);
    expect(s[2]).toBe(0);
  });
});

describe("hybridRank", () => {
  it("returns [] for no candidates", () => {
    expect(hybridRank("x", [])).toEqual([]);
  });

  it("fuses: a mid dense hit that is also the top keyword hit beats a dense-only top hit", () => {
    const out = hybridRank(
      "alpha",
      [c("d1", { dense: 0.9 }), c("both", { dense: 0.8, keyword: 5 }), c("d3", { dense: 0.7 })],
      { adaptive: false },
    );
    expect(out[0].id).toBe("both");
  });

  it("coverage boost lifts the candidate matching all terms", () => {
    const out = hybridRank(
      "payment timeout runbook",
      [
        c("partial", { dense: 0.9, keyword: 3, title: "Payment notes", text: "payment" }),
        c("full", { dense: 0.89, keyword: 2.9, title: "Payment timeout runbook", text: "" }),
      ],
      { adaptive: false },
    );
    expect(out[0].id).toBe("full");
  });

  it("MMR demotes a near-duplicate below a distinct relevant candidate", () => {
    const out = hybridRank(
      "ingress",
      [
        c("a", { group: "n1", dense: 0.9, keyword: 4 }),
        c("a2", { group: "n1", dense: 0.89, keyword: 3.9 }),
        c("b", { group: "n2", dense: 0.85, keyword: 3.5 }),
      ],
      { adaptive: false },
    );
    expect(out.map((o) => o.id)).toEqual(["a", "b", "a2"]);
  });

  it("MMR uses vectors when present", () => {
    const v = (...n: number[]) => Float32Array.from(n);
    const out = hybridRank(
      "q",
      [
        c("a", { dense: 0.9, vector: v(1, 0) }),
        c("a-copy", { dense: 0.89, vector: v(1, 0.01) }),
        c("other", { dense: 0.86, vector: v(0, 1) }),
      ],
      { adaptive: false },
    );
    expect(out.map((o) => o.id)).toEqual(["a", "other", "a-copy"]);
  });

  it("adaptive-k cuts at a large score gap but the dense floor keeps the top 3", () => {
    const cands = [
      c("top", { dense: 0.9, keyword: 9, title: "needle", text: "" }),
      c("n2", { dense: 0.5 }),
      c("n3", { dense: 0.4 }),
      c("n4", { dense: 0.3 }),
      c("n5", { dense: 0.2 }),
    ];
    const cut = hybridRank("needle", cands, { floor: 1 });
    expect(cut.map((o) => o.id)).toEqual(["top"]);
    const floored = hybridRank("needle", cands, { floor: 3 });
    expect(floored.map((o) => o.id).sort()).toEqual(["n2", "n3", "top"]);
  });

  it("never exceeds maxK and keeps floor hits inside it", () => {
    const cands = Array.from({ length: 10 }, (_, i) => c(`x${i}`, { dense: 1 - i * 0.01 }));
    const out = hybridRank("q", cands, { adaptive: false, maxK: 4, floor: 3 });
    expect(out).toHaveLength(4);
    for (const id of ["x0", "x1", "x2"]) expect(out.map((o) => o.id)).toContain(id);
  });

  it("works with keyword-only and dense-only candidate sets; scores stay in 0..1", () => {
    const kw = hybridRank("zeta", [c("a", { keyword: 2 }), c("b", { keyword: 1 })], { adaptive: false });
    expect(kw[0].id).toBe("a");
    const dn = hybridRank("zeta", [c("a", { dense: 0.2 }), c("b", { dense: 0.9 })], { adaptive: false });
    expect(dn[0].id).toBe("b");
    for (const o of [...kw, ...dn]) {
      expect(o.score).toBeGreaterThanOrEqual(0);
      expect(o.score).toBeLessThanOrEqual(1);
    }
  });
});
