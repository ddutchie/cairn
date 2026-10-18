import { describe, expect, it } from "vitest";
import { CONFIDENT_SCORE, pickProject, scoreProjects, termOverlap } from "./rank";

describe("scoreProjects", () => {
  it("weights a project's best hits and sorts descending", () => {
    const scores = scoreProjects([
      { projectId: "a", rank: 0.9 },
      { projectId: "b", rank: 0.8 },
      { projectId: "b", rank: 0.8 },
      { projectId: "b", rank: 0.8 },
      { projectId: "b", rank: 0.8 },
    ]);
    // Several related notes lift b above a's single strong hit: b = 0.8 + 0.4 + 0.2
    // (the fourth hit is ignored).
    expect(scores.map((s) => s.projectId)).toEqual(["b", "a"]);
    expect(scores[0].score).toBeCloseTo(1.4);
    expect(scores[1].score).toBeCloseTo(0.9);
  });

  it("lets one strong hit beat a scatter of weak ones", () => {
    const scores = scoreProjects([
      { projectId: "a", rank: 0.9 },
      { projectId: "b", rank: 0.5 },
      { projectId: "b", rank: 0.5 },
      { projectId: "b", rank: 0.5 },
    ]);
    expect(scores.map((s) => s.projectId)).toEqual(["a", "b"]);
  });

  it("returns [] for no candidates and ignores bad ranks", () => {
    expect(scoreProjects([])).toEqual([]);
    expect(scoreProjects([{ projectId: "a", rank: NaN }, { projectId: "", rank: 1 }])).toEqual([]);
  });
});

describe("pickProject", () => {
  const projects = [{ id: "a" }, { id: "b" }];

  it("takes the best project when it clears the threshold", () => {
    expect(pickProject({ projects, projectScores: [{ projectId: "b", score: CONFIDENT_SCORE }], recentProjectId: "a" })).toEqual({
      projectId: "b",
      confident: true,
    });
  });

  it("prefers the recent project over a weak match", () => {
    expect(pickProject({ projects, projectScores: [{ projectId: "b", score: 0.1 }], recentProjectId: "a" })).toEqual({
      projectId: "a",
      confident: false,
    });
  });

  it("falls back to a weak match, then the first project, then null", () => {
    expect(pickProject({ projects, projectScores: [{ projectId: "b", score: 0.1 }], recentProjectId: null })?.projectId).toBe("b");
    expect(pickProject({ projects, projectScores: [], recentProjectId: "gone" })?.projectId).toBe("a");
    expect(pickProject({ projects: [], projectScores: [], recentProjectId: null })).toBeNull();
  });

  it("ignores scores for projects that no longer exist", () => {
    expect(pickProject({ projects, projectScores: [{ projectId: "deleted", score: 5 }], recentProjectId: null })?.projectId).toBe("a");
  });
});

describe("termOverlap", () => {
  it("is the share of query terms present in the title", () => {
    expect(termOverlap(["kitchen", "tiles"], "Kitchen renovation")).toBe(0.5);
    expect(termOverlap(["x"], "abc")).toBe(0);
    expect(termOverlap([], "abc")).toBe(0);
  });
});
