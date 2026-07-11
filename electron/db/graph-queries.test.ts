import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./schema";
import {
  createWorkspace,
  createProject,
  createNote,
  createColumn,
  createCard,
  upsertNoteEmbedding,
  upsertTaskEmbedding,
} from "./queries";
import {
  computeSemanticRelationships,
  getKnowledgeGraph,
} from "./graph-queries";

const TOP_K = 5;
const FLOOR = 0.55;

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
  sectionIdx: number = 0,
  sectionTitle: string = "",
) {
  upsertNoteEmbedding(db, {
    noteId,
    sectionIdx,
    sectionTitle,
    workspaceId: "ws1",
    model: "test-model",
    task: "search_document",
    contentHash: "hash-" + noteId + "-" + sectionIdx,
    vector,
  });
}

function upsertSection(
  db: Database.Database,
  noteId: string,
  sectionIdx: number,
  sectionTitle: string,
  vector: number[],
) {
  upsertNoteEmbedding(db, {
    noteId,
    sectionIdx,
    sectionTitle,
    workspaceId: "ws1",
    model: "test-model",
    task: "search_document",
    contentHash: "hash-" + noteId + "-" + sectionIdx,
    vector,
  });
}

function semEdges(db: Database.Database) {
  return getKnowledgeGraph(db, "ws1").edges.filter((e) => e.type === "semantic");
}

/** Create a board column + card so the card exists as a graph node, then embed
 *  it — used to exercise task↔task and note↔task semantic edges. */
function upsertCardEmbedding(
  db: Database.Database,
  cardId: string,
  vector: number[],
  title: string = cardId,
  sectionIdx: number = 0,
  sectionTitle: string = "",
) {
  const columnId = "col1";
  const existing = db.prepare("SELECT id FROM board_columns WHERE id = ?").get(columnId);
  if (!existing) {
    createColumn(db, { id: columnId, projectId: "p1", workspaceId: "ws1", name: "Todo", type: "todo", order: 0 });
  }
  const card = db.prepare("SELECT id FROM task_cards WHERE id = ?").get(cardId);
  if (!card) {
    createCard(db, { id: cardId, columnId, projectId: "p1", workspaceId: "ws1", title });
  }
  upsertTaskEmbedding(db, {
    cardId,
    sectionIdx,
    sectionTitle,
    workspaceId: "ws1",
    model: "test-model",
    task: "search_document",
    contentHash: "chash-" + cardId + "-" + sectionIdx,
    vector,
  });
}

function findEdge(edges: ReturnType<typeof semEdges>, a: string, b: string) {
  return edges.find(
    (e) =>
      (e.source === a && e.target === b) ||
      (e.source === b && e.target === a),
  );
}

function cosineApprox(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

describe("computeSemanticRelationships — top-K behaviour (single-section)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seed(db);
    createNote(db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "A", contentText: "alpha" });
    createNote(db, { id: "n2", projectId: "p1", workspaceId: "ws1", title: "B", contentText: "beta" });
    createNote(db, { id: "n3", projectId: "p1", workspaceId: "ws1", title: "C", contentText: "gamma" });
  });

  it("creates no edges when embeddings table is empty", () => {
    computeSemanticRelationships(db, "ws1");
    expect(semEdges(db)).toHaveLength(0);
  });

  it("connects each note to its single peer when only 2 notes exist", () => {
    upsertEmbedding(db, "n1", vec(1, 0, 0, 0));
    upsertEmbedding(db, "n2", vec(0.9, 0.44, 0, 0));
    computeSemanticRelationships(db, "ws1");
    const edges = semEdges(db);
    expect(edges).toHaveLength(1);
    expect(findEdge(edges, "n1", "n2")).toBeDefined();
  });

  it("respects floor: pairs below 0.55 are NOT connected even if they'd be in top-K", () => {
    upsertEmbedding(db, "n1", vec(1, 0, 0, 0));
    upsertEmbedding(db, "n2", vec(0.3, 0.95, 0, 0));
    computeSemanticRelationships(db, "ws1");
    expect(semEdges(db)).toHaveLength(0);
  });

  it("caps each note at TOP_K=5 outgoing edges", () => {
    for (let i = 1; i <= 8; i++) {
      const id = "m" + i;
      createNote(db, { id, projectId: "p1", workspaceId: "ws1", title: "M" + i, contentText: "shared topic " + i });
      upsertEmbedding(db, id, vec(1, i * 0.001, 0, 0));
    }
    computeSemanticRelationships(db, "ws1");
    const edges = semEdges(db);
    const fromM1 = edges.filter((e) => e.source === "m1" || e.target === "m1");
    expect(fromM1.length).toBeLessThanOrEqual(TOP_K);
  });

  it("creates edges for pairs with cosine >= 0.55 even if below old 0.78 threshold", () => {
    const v1 = vec(1, 0, 0, 0);
    const v2 = vec(0.7, 0.71, 0, 0);
    upsertEmbedding(db, "n1", v1);
    upsertEmbedding(db, "n2", v2);
    computeSemanticRelationships(db, "ws1");
    const edges = semEdges(db);
    expect(edges).toHaveLength(1);
    const edge = edges[0];
    expect(edge.weight).toBeGreaterThanOrEqual(FLOOR);
    expect(edge.weight).toBeLessThan(0.78);
  });

  it("does not create edges for orthogonal (cosine ≈ 0) notes", () => {
    upsertEmbedding(db, "n1", vec(1, 0, 0, 0));
    upsertEmbedding(db, "n3", vec(0, 0, 0, 1));
    computeSemanticRelationships(db, "ws1");
    expect(semEdges(db)).toHaveLength(0);
  });

  it("deduplicates via canonical source<target ordering", () => {
    upsertEmbedding(db, "n1", vec(1, 0, 0, 0));
    upsertEmbedding(db, "n2", vec(1, 0, 0, 0));
    computeSemanticRelationships(db, "ws1");
    const edges = semEdges(db).filter(
      (e) => (e.source === "n1" && e.target === "n2") || (e.source === "n2" && e.target === "n1"),
    );
    expect(edges).toHaveLength(1);
  });

  it("incremental mode (entityIds) recomputes only active notes' edges", () => {
    upsertEmbedding(db, "n1", vec(1, 0, 0, 0));
    upsertEmbedding(db, "n2", vec(0.95, 0.31, 0, 0));
    upsertEmbedding(db, "n3", vec(0, 0, 0, 1));
    computeSemanticRelationships(db, "ws1", ["n1"]);
    const edges = semEdges(db);
    expect(edges).toHaveLength(1);
    expect(findEdge(edges, "n1", "n2")).toBeDefined();
    expect(findEdge(edges, "n2", "n3")).toBeUndefined();
  });

  it("idempotent: calling twice doesn't duplicate rows", () => {
    upsertEmbedding(db, "n1", vec(1, 0, 0, 0));
    upsertEmbedding(db, "n2", vec(1, 0, 0, 0));
    computeSemanticRelationships(db, "ws1");
    computeSemanticRelationships(db, "ws1");
    const edges = semEdges(db).filter(
      (e) => (e.source === "n1" && e.target === "n2") || (e.source === "n2" && e.target === "n1"),
    );
    expect(edges).toHaveLength(1);
  });

  it("produces edges: weights are valid in [0.55, 1.0]", () => {
    upsertEmbedding(db, "n1", vec(1, 0, 0, 0));
    upsertEmbedding(db, "n2", vec(0.85, 0.53, 0, 0));
    computeSemanticRelationships(db, "ws1");
    const edge = semEdges(db)[0];
    expect(edge.weight).toBeGreaterThanOrEqual(FLOOR);
    expect(edge.weight).toBeLessThanOrEqual(1);
  });
});

describe("computeSemanticRelationships — multi-section notes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seed(db);
    createNote(db, { id: "plan", projectId: "p1", workspaceId: "ws1", title: "Project Plan", contentText: "intro" });
    createNote(db, { id: "arch", projectId: "p1", workspaceId: "ws1", title: "Architecture", contentText: "microservices" });
    createNote(db, { id: "mkt", projectId: "p1", workspaceId: "ws1", title: "Marketing", contentText: "go to market" });
  });

  it("a note with 2 sections gets edges from BOTH sections", () => {
    const archVec = vec(1, 0, 0, 0);
    const marketingVec = vec(0, 1, 0, 0);
    const archDoc = vec(0.98, 0.2, 0, 0);
    const mktDoc = vec(0.1, 0.99, 0, 0);

    upsertSection(db, "plan", 0, "Architecture", archVec);
    upsertSection(db, "plan", 1, "Marketing", marketingVec);
    upsertEmbedding(db, "arch", archDoc, 0, "");
    upsertEmbedding(db, "mkt", mktDoc, 0, "");

    computeSemanticRelationships(db, "ws1");

    const edges = semEdges(db);
    expect(findEdge(edges, "plan", "arch")).toBeDefined();
    expect(findEdge(edges, "plan", "mkt")).toBeDefined();
  });

  it("section titles are stored on the semantic edge", () => {
    const archVec = vec(1, 0, 0, 0);
    const archDoc = vec(0.98, 0.2, 0, 0);

    upsertSection(db, "plan", 0, "Architecture", archVec);
    upsertSection(db, "plan", 1, "Marketing", vec(0, 1, 0, 0));
    upsertEmbedding(db, "arch", archDoc, 0, "");

    computeSemanticRelationships(db, "ws1");

    const edge = findEdge(semEdges(db), "plan", "arch");
    expect(edge).toBeDefined();
    expect(edge!.sourceSectionTitle).toBeDefined();
    expect(edge!.targetSectionTitle).toBeDefined();
  });

  it("best weight per note-pair wins when multiple sections match", () => {
    const v1a = vec(1, 0, 0, 0);
    const v1b = vec(0.8, 0.6, 0, 0);
    const v2a = vec(0.98, 0.2, 0, 0);
    const v2b = vec(0.79, 0.62, 0, 0);

    upsertSection(db, "plan", 0, "Section A", v1a);
    upsertSection(db, "plan", 1, "Section B", v1b);
    upsertSection(db, "arch", 0, "Doc A", v2a);
    upsertSection(db, "arch", 1, "Doc B", v2b);

    computeSemanticRelationships(db, "ws1");

    const edge = findEdge(semEdges(db), "plan", "arch");
    expect(edge).toBeDefined();
    const maxSim = Math.max(
      cosineApprox(v1a, v2a), cosineApprox(v1a, v2b),
      cosineApprox(v1b, v2a), cosineApprox(v1b, v2b),
    );
    expect(edge!.weight).toBe(round2(maxSim));
  });

  it("single-section note connects to multi-section note via best section match", () => {
    const archVec = vec(1, 0, 0, 0);
    const unrelatedVec = vec(0, 0, 0, 1);
    const archDoc = vec(0.95, 0.31, 0, 0);

    upsertSection(db, "plan", 0, "Architecture", archVec);
    upsertSection(db, "plan", 1, "Random Stuff", unrelatedVec);
    upsertEmbedding(db, "arch", archDoc, 0, "");

    computeSemanticRelationships(db, "ws1");

    const edges = semEdges(db);
    expect(findEdge(edges, "plan", "arch")).toBeDefined();
  });
});

describe("scenario: topic clusters with realistic cosines", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seed(db);

    createNote(db, { id: "react", projectId: "p1", workspaceId: "ws1", title: "React Hooks", contentText: "useState, useEffect" });
    createNote(db, { id: "vue", projectId: "p1", workspaceId: "ws1", title: "Vue Composables", contentText: "ref, computed" });
    createNote(db, { id: "svelte", projectId: "p1", workspaceId: "ws1", title: "Svelte Stores", contentText: "writable, derived" });
    createNote(db, { id: "python", projectId: "p1", workspaceId: "ws1", title: "Python Decorators", contentText: "@app.route" });
    createNote(db, { id: "ruby", projectId: "p1", workspaceId: "ws1", title: "Ruby Blocks", contentText: "yield, proc" });
    createNote(db, { id: "pizza", projectId: "p1", workspaceId: "ws1", title: "Pizza Recipe", contentText: "flour, tomato, mozzarella" });
  });

  it("connects notes within topic clusters, isolates unrelated notes", () => {
    const react   = vec(1.00, 0.00, 0.00, 0.00);
    const vue     = vec(0.98, 0.20, 0.00, 0.00);
    const svelte  = vec(0.88, 0.48, 0.00, 0.00);
    const python  = vec(0.00, 1.00, 0.00, 0.00);
    const ruby    = vec(0.00, 0.98, 0.20, 0.00);
    const pizza   = vec(0.00, 0.00, 0.00, 1.00);

    upsertEmbedding(db, "react", react);
    upsertEmbedding(db, "vue", vue);
    upsertEmbedding(db, "svelte", svelte);
    upsertEmbedding(db, "python", python);
    upsertEmbedding(db, "ruby", ruby);
    upsertEmbedding(db, "pizza", pizza);

    computeSemanticRelationships(db, "ws1");

    const edges = semEdges(db);

    const expected = [
      { a: "react",  b: "vue",     w: round2(cosineApprox(react, vue)) },
      { a: "react",  b: "svelte",  w: round2(cosineApprox(react, svelte)) },
      { a: "vue",    b: "svelte",  w: round2(cosineApprox(vue, svelte)) },
      { a: "python", b: "ruby",    w: round2(cosineApprox(python, ruby)) },
    ];

    expect(edges).toHaveLength(expected.length);

    for (const ex of expected) {
      const edge = findEdge(edges, ex.a, ex.b);
      expect(edge, `expected edge ${ex.a}↔${ex.b}`).toBeDefined();
      expect(edge!.weight).toBe(ex.w);
    }

    expect(findEdge(edges, "pizza", "react")).toBeUndefined();
    expect(findEdge(edges, "pizza", "vue")).toBeUndefined();
    expect(findEdge(edges, "pizza", "python")).toBeUndefined();
    expect(findEdge(edges, "pizza", "ruby")).toBeUndefined();
    expect(findEdge(edges, "react", "python")).toBeUndefined();
    expect(findEdge(edges, "vue", "ruby")).toBeUndefined();
    expect(findEdge(edges, "svelte", "python")).toBeUndefined();
  });

  it("slider at 1.0 hides all semantic edges (hard links only)", () => {
    upsertEmbedding(db, "react", vec(1, 0, 0, 0));
    upsertEmbedding(db, "vue", vec(0.99, 0.14, 0, 0));
    computeSemanticRelationships(db, "ws1");
    const all = semEdges(db);
    expect(all.length).toBe(1);
    const visibleAtOne = all.filter((e) => (e.weight ?? 1) >= 1.0);
    expect(visibleAtOne).toHaveLength(0);
  });

  it("incremental recompute for a single note preserves other clusters' edges", () => {
    upsertEmbedding(db, "react", vec(1, 0, 0, 0));
    upsertEmbedding(db, "vue", vec(0.98, 0.2, 0, 0));
    upsertEmbedding(db, "python", vec(0, 1, 0, 0));
    upsertEmbedding(db, "ruby", vec(0, 0.98, 0.2, 0));

    computeSemanticRelationships(db, "ws1");
    expect(findEdge(semEdges(db), "python", "ruby")).toBeDefined();

    upsertEmbedding(db, "react", vec(0.97, 0.24, 0, 0));
    computeSemanticRelationships(db, "ws1", ["react"]);

    const edges = semEdges(db);
    expect(findEdge(edges, "python", "ruby")).toBeDefined();
    expect(findEdge(edges, "react", "vue")).toBeDefined();
  });
});

describe("scenario: multi-topic note discovers connections via sections", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seed(db);
    createNote(db, { id: "plan", projectId: "p1", workspaceId: "ws1", title: "Project Plan", contentText: "intro" });
    createNote(db, { id: "arch", projectId: "p1", workspaceId: "ws1", title: "Architecture Doc", contentText: "microservices" });
    createNote(db, { id: "mkt", projectId: "p1", workspaceId: "ws1", title: "Marketing Plan", contentText: "go to market" });
    createNote(db, { id: "cooking", projectId: "p1", workspaceId: "ws1", title: "Cooking Notes", contentText: "pasta recipe" });
  });

  it("multi-topic note connects to architecture AND marketing notes", () => {
    const archVec = vec(1, 0, 0, 0);
    const mktVec = vec(0, 1, 0, 0);
    const archDoc = vec(0.98, 0.2, 0, 0);
    const mktDoc = vec(0.1, 0.99, 0, 0);
    const cookingVec = vec(0, 0, 0, 1);

    upsertSection(db, "plan", 0, "Architecture", archVec);
    upsertSection(db, "plan", 1, "Marketing", mktVec);
    upsertEmbedding(db, "arch", archDoc, 0, "Architecture");
    upsertEmbedding(db, "mkt", mktDoc, 0, "Marketing");
    upsertEmbedding(db, "cooking", cookingVec, 0, "Recipe");

    computeSemanticRelationships(db, "ws1");

    const edges = semEdges(db);
    expect(findEdge(edges, "plan", "arch")).toBeDefined();
    expect(findEdge(edges, "plan", "mkt")).toBeDefined();
    expect(findEdge(edges, "arch", "cooking")).toBeUndefined();
    expect(findEdge(edges, "mkt", "cooking")).toBeUndefined();
    expect(findEdge(edges, "plan", "cooking")).toBeUndefined();
  });

  it("section titles appear on edges for multi-section notes", () => {
    const archVec = vec(1, 0, 0, 0);
    const mktVec = vec(0, 1, 0, 0);
    const archDoc = vec(0.98, 0.2, 0, 0);
    const mktDoc = vec(0.1, 0.99, 0, 0);

    upsertSection(db, "plan", 0, "Architecture", archVec);
    upsertSection(db, "plan", 1, "Marketing", mktVec);
    upsertEmbedding(db, "arch", archDoc, 0, "Architecture");
    upsertEmbedding(db, "mkt", mktDoc, 0, "Marketing");

    computeSemanticRelationships(db, "ws1");

    const archEdge = findEdge(semEdges(db), "plan", "arch");
    expect(archEdge).toBeDefined();
    expect(archEdge!.sourceSectionTitle).toBeDefined();

    const mktEdge = findEdge(semEdges(db), "plan", "mkt");
    expect(mktEdge).toBeDefined();
    expect(mktEdge!.sourceSectionTitle).toBeDefined();
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
    upsertEmbedding(db, "na", vec(1, 0, 0, 0));
    upsertEmbedding(db, "nb", vec(0.98, 0.2, 0, 0));
    upsertEmbedding(db, "nc", vec(0, 0, 0, 1));
    computeSemanticRelationships(db, "ws1");
    const edges = semEdges(db);
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(findEdge(edges, "na", "nb")).toBeDefined();
  });

  it("semantic edges filtered out when edgeTypes omits 'semantic'", () => {
    upsertEmbedding(db, "na", vec(1, 0, 0, 0));
    upsertEmbedding(db, "nb", vec(1, 0, 0, 0));
    computeSemanticRelationships(db, "ws1");
    const graph = getKnowledgeGraph(db, "ws1", { includeAuto: true, edgeTypes: ["note-note", "project-member"] });
    expect(graph.edges.filter((e) => e.type === "semantic")).toHaveLength(0);
  });

  it("forms task↔task and note↔task semantic edges across kinds", () => {
    // One note + two cards, all pointing the same direction → all similar.
    upsertEmbedding(db, "na", vec(1, 0, 0, 0));
    upsertCardEmbedding(db, "ca", vec(0.98, 0.2, 0, 0), "Card A");
    upsertCardEmbedding(db, "cb", vec(0.97, 0.24, 0, 0), "Card B");
    // An unrelated card that must NOT link.
    upsertCardEmbedding(db, "cz", vec(0, 0, 0, 1), "Card Z");

    computeSemanticRelationships(db, "ws1");
    const edges = semEdges(db);

    // task↔task
    expect(findEdge(edges, "ca", "cb")).toBeDefined();
    // note↔task (both directions of the pair covered by findEdge)
    expect(findEdge(edges, "na", "ca")).toBeDefined();
    expect(findEdge(edges, "na", "cb")).toBeDefined();
    // unrelated card stays disconnected
    expect(findEdge(edges, "na", "cz")).toBeUndefined();
    expect(findEdge(edges, "ca", "cz")).toBeUndefined();
  });

  it("semantic edges absent when includeAuto is false", () => {
    upsertEmbedding(db, "na", vec(1, 0, 0, 0));
    upsertEmbedding(db, "nb", vec(1, 0, 0, 0));
    computeSemanticRelationships(db, "ws1");
    const graph = getKnowledgeGraph(db, "ws1", { includeAuto: false });
    expect(graph.edges.filter((e) => e.type === "semantic")).toHaveLength(0);
  });

  it("weight rounded to 2 decimal places", () => {
    upsertEmbedding(db, "na", vec(1, 0, 0, 0));
    upsertEmbedding(db, "nb", vec(0.8, 0.6, 0, 0));
    computeSemanticRelationships(db, "ws1");
    const edge = semEdges(db)[0];
    expect(edge).toBeDefined();
    expect(edge.weight).toBe(Math.round(edge.weight! * 100) / 100);
  });
});

describe("getKnowledgeGraph — client-side threshold filter", () => {
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

  it("all semantic edges returned from DB regardless of weight", () => {
    expect(semEdges(db).length).toBeGreaterThanOrEqual(1);
  });

  it("client-side threshold filter masks edges below cutoff", () => {
    const graph = getKnowledgeGraph(db, "ws1");
    const threshold = 0.99;
    const visible = graph.edges.filter((e) => e.type !== "semantic" || (e.weight ?? 1) >= threshold);
    const allSem = graph.edges.filter((e) => e.type === "semantic");
    const semBelow = allSem.filter((e) => (e.weight ?? 1) < threshold);
    expect(visible.filter((e) => e.type === "semantic").length + semBelow.length).toBe(allSem.length);
  });
});
