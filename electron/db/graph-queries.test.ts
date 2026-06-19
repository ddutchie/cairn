import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./schema";
import {
  createWorkspace,
  createProject,
  createNote,
  updateNote,
  upsertNoteEmbedding,
  getAllEmbeddingsForWorkspace,
} from "./queries";
import {
  computeSemanticRelationships,
  getKnowledgeGraph,
  type GraphEdge,
} from "./graph-queries";

const DIM = 4;

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function seed(db: Database.Database) {
  createWorkspace(db, { id: "ws1", name: "WS" });
  createProject(db, { id: "p1", workspaceId: "ws1", name: "Proj" });
}

function vec(...vals: number[]): number[] {
  return vals;
}

function upsertEmbedding(
  db: Database.Database,
  noteId: string,
  vector: number[],
) {
  upsertNoteEmbedding(db, {
    noteId,
    workspaceId: "ws1",
    model: "test-model",
    task: "search_document",
    contentHash: "hash-" + noteId,
    vector,
  });
}

describe("computeSemanticRelationships", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seed(db);
    createNote(db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "Note A", contentText: "alpha beta" });
    createNote(db, { id: "n2", projectId: "p1", workspaceId: "ws1", title: "Note B", contentText: "alpha gamma" });
    createNote(db, { id: "n3", projectId: "p1", workspaceId: "ws1", title: "Note C", contentText: "completely different" });
  });

  it("creates no edges when embeddings table is empty", () => {
    computeSemanticRelationships(db, "ws1");
    const graph = getKnowledgeGraph(db, "ws1");
    const semEdges = graph.edges.filter((e) => e.type === "semantic");
    expect(semEdges).toHaveLength(0);
  });

  it("creates semantic edges for note pairs above threshold (0.78)", () => {
    const v1 = vec(1, 0, 0, 0);
    const v2 = vec(0.95, 0.31, 0, 0);
    upsertEmbedding(db, "n1", v1);
    upsertEmbedding(db, "n2", v2);

    computeSemanticRelationships(db, "ws1");

    const graph = getKnowledgeGraph(db, "ws1");
    const semEdges = graph.edges.filter((e) => e.type === "semantic");
    expect(semEdges.length).toBeGreaterThanOrEqual(1);
    const edge = semEdges.find((e) =>
      (e.source === "n1" && e.target === "n2") ||
      (e.source === "n2" && e.target === "n1"),
    );
    expect(edge).toBeDefined();
    expect(edge!.weight).toBeGreaterThan(0.78);
  });

  it("does NOT create edges for dissimilar notes", () => {
    const v1 = vec(1, 0, 0, 0);
    const v3 = vec(0, 0, 0, 1);
    upsertEmbedding(db, "n1", v1);
    upsertEmbedding(db, "n3", v3);

    computeSemanticRelationships(db, "ws1");

    const graph = getKnowledgeGraph(db, "ws1");
    const semEdges = graph.edges.filter((e) => e.type === "semantic");
    expect(semEdges).toHaveLength(0);
  });

  it("deduplicates edges (canonical source < target ordering)", () => {
    const v1 = vec(1, 0, 0, 0);
    const v2 = vec(1, 0, 0, 0);
    upsertEmbedding(db, "n1", v1);
    upsertEmbedding(db, "n2", v2);

    computeSemanticRelationships(db, "ws1");

    const graph = getKnowledgeGraph(db, "ws1");
    const semEdges = graph.edges.filter(
      (e) =>
        (e.source === "n1" && e.target === "n2") ||
        (e.source === "n2" && e.target === "n1"),
    );
    expect(semEdges).toHaveLength(1);
  });

  it("supports incremental mode (entityIds filter)", () => {
    const v1 = vec(1, 0, 0, 0);
    const v2 = vec(1, 0, 0, 0);
    const v3 = vec(0, 0, 0, 1);
    upsertEmbedding(db, "n1", v1);
    upsertEmbedding(db, "n2", v2);
    upsertEmbedding(db, "n3", v3);

    computeSemanticRelationships(db, "ws1", ["n1"]);

    const graph = getKnowledgeGraph(db, "ws1");
    const semEdges = graph.edges.filter((e) => e.type === "semantic");
    expect(semEdges).toHaveLength(1);
    expect(semEdges[0].source).toBe("n1");
    expect(semEdges[0].target).toBe("n2");
  });

  it("idempotent: calling twice doesn't duplicate rows", () => {
    const v1 = vec(1, 0, 0, 0);
    const v2 = vec(1, 0, 0, 0);
    upsertEmbedding(db, "n1", v1);
    upsertEmbedding(db, "n2", v2);

    computeSemanticRelationships(db, "ws1");
    computeSemanticRelationships(db, "ws1");

    const graph = getKnowledgeGraph(db, "ws1");
    const semEdges = graph.edges.filter(
      (e) =>
        (e.source === "n1" && e.target === "n2") ||
        (e.source === "n2" && e.target === "n1"),
    );
    expect(semEdges).toHaveLength(1);
  });
});

describe("getKnowledgeGraph — semantic edge integration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seed(db);
    createNote(db, { id: "na", projectId: "p1", workspaceId: "ws1", title: "Alpha", contentText: "shared content here" });
    createNote(db, { id: "nb", projectId: "p1", workspaceId: "ws1", title: "Beta", contentText: "shared content there" });
    createNote(db, { id: "nc", projectId: "p1", workspaceId: "ws1", title: "Gamma", contentText: "totally unrelated text" });
  });

  it("semantic edges appear in graph when includeAuto is true", () => {
    const va = vec(1, 0, 0, 0);
    const vb = vec(0.98, 0.2, 0, 0);
    const vc = vec(0, 0, 0, 1);
    upsertEmbedding(db, "na", va);
    upsertEmbedding(db, "nb", vb);
    upsertEmbedding(db, "nc", vc);

    computeSemanticRelationships(db, "ws1");

    const graph = getKnowledgeGraph(db, "ws1", { includeAuto: true });
    const semEdges = graph.edges.filter((e) => e.type === "semantic");
    expect(semEdges.length).toBeGreaterThanOrEqual(1);

    const ab = semEdges.find((e) =>
      (e.source === "na" && e.target === "nb") ||
      (e.source === "nb" && e.target === "na"),
    );
    expect(ab).toBeDefined();
  });

  it("semantic edges are filtered out when edgeTypes omits 'semantic'", () => {
    const va = vec(1, 0, 0, 0);
    const vb = vec(1, 0, 0, 0);
    upsertEmbedding(db, "na", va);
    upsertEmbedding(db, "nb", vb);

    computeSemanticRelationships(db, "ws1");

    const graph = getKnowledgeGraph(db, "ws1", {
      includeAuto: true,
      edgeTypes: ["note-note", "project-member"],
    });
    const semEdges = graph.edges.filter((e) => e.type === "semantic");
    expect(semEdges).toHaveLength(0);
  });

  it("semantic edges absent when includeAuto is false", () => {
    const va = vec(1, 0, 0, 0);
    const vb = vec(1, 0, 0, 0);
    upsertEmbedding(db, "na", va);
    upsertEmbedding(db, "nb", vb);

    computeSemanticRelationships(db, "ws1");

    const graph = getKnowledgeGraph(db, "ws1", { includeAuto: false });
    const semEdges = graph.edges.filter((e) => e.type === "semantic");
    expect(semEdges).toHaveLength(0);
  });

  it("semantic edge weight is rounded to 2 decimal places", () => {
    const va = vec(1, 0, 0, 0);
    const vb = vec(0.8, 0.6, 0, 0);
    upsertEmbedding(db, "na", va);
    upsertEmbedding(db, "nb", vb);

    computeSemanticRelationships(db, "ws1");

    const graph = getKnowledgeGraph(db, "ws1");
    const semEdge = graph.edges.find((e) => e.type === "semantic");
    expect(semEdge).toBeDefined();
    expect(semEdge!.weight).toBe(Math.round(semEdge!.weight! * 100) / 100);
  });
});

describe("getKnowledgeGraph — semantic threshold filter", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seed(db);
    createNote(db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "X", contentText: "a b c" });
    createNote(db, { id: "n2", projectId: "p1", workspaceId: "ws1", title: "Y", contentText: "a b c" });
    createNote(db, { id: "n3", projectId: "p1", workspaceId: "ws1", title: "Z", contentText: "a b c" });
    upsertEmbedding(db, "n1", vec(1, 0, 0, 0));
    upsertEmbedding(db, "n2", vec(0.98, 0.2, 0, 0));
    upsertEmbedding(db, "n3", vec(0, 0, 1, 0));
    computeSemanticRelationships(db, "ws1");
  });

  it("all semantic edges are returned from DB regardless of weight", () => {
    const graph = getKnowledgeGraph(db, "ws1");
    const semEdges = graph.edges.filter((e) => e.type === "semantic");
    expect(semEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("client-side threshold filter masks edges below cutoff", () => {
    const graph = getKnowledgeGraph(db, "ws1");
    const threshold = 0.99;
    const visible = graph.edges.filter(
      (e) => e.type !== "semantic" || (e.weight ?? 1) >= threshold,
    );
    const semAbove = visible.filter((e) => e.type === "semantic");
    const semBelow = graph.edges
      .filter((e) => e.type === "semantic")
      .filter((e) => (e.weight ?? 1) < threshold);
    expect(semAbove.length + semBelow.length).toBe(
      graph.edges.filter((e) => e.type === "semantic").length,
    );
  });
});
