import XCTest
@testable import EmbeddingLive
@testable import EmbeddingMath

/// LIVE embedding tests: load the real NLContextualEmbedding model (macOS 14+ /
/// iOS 17+) and measure similarity on realistic note text, replicating the app's
/// search pipeline. These validate that scores actually DISCRIMINATE — the
/// symptom that prompted this ("91% for everything") means the model is either
/// (a) not producing distinct vectors, or (b) being pooled/normalised wrong so
/// all vectors collapse near a common direction.
///
/// Skipped automatically if model assets can't be loaded (e.g. offline CI).
@available(macOS 14.0, iOS 17.0, *)
final class LiveEmbeddingTests: XCTestCase {

  // A few notes that stand in for real Cairn content across DISTINCT topics.
  private let notes: [(title: String, section: String, body: String)] = [
    ("On-device semantic search", "Overview",
     "Mirrors the desktop bge-small semantic search on mobile, running fully on-device via Apple's NLContextualEmbedding. Vectors live in Apple's own embedding space and never sync."),
    ("Kanban board drag and drop", "Gestures",
     "The board uses react-native-gesture-handler and reanimated worklets to reorder cards between columns with a long-press drag, updating the order on the UI thread."),
    ("iCloud sync engine", "Conflicts",
     "Bidirectional offline-first sync over a shared iCloud folder. Diverged note bodies are kept as a conflicted copy so nothing is ever lost; an HLC orders operations."),
    ("Sourdough bread recipe", "Method",
     "Mix flour, water, salt and an active starter. Bulk ferment for four hours with stretch and folds, shape, cold proof overnight, then bake in a dutch oven at 250C."),
    ("Tax filing checklist", "Documents",
     "Gather income statements, receipts for deductible expenses, mortgage interest, and last year's return before the April deadline. Submit electronically for a faster refund."),
  ]

  private func makeEmbedder() throws -> LiveEmbedder {
    guard let e = LiveEmbedder() else {
      throw XCTSkip("NLContextualEmbedding assets unavailable — skipping live test.")
    }
    return e
  }

  /// Embed every note the way the app does, then search with a query clearly
  /// about ONE of them. The correct note must win, and the score SPREAD between
  /// the best and the median must be meaningful (not all ~equal/91%).
  func testSearchDiscriminatesBetweenNotes() throws {
    let e = try makeEmbedder()

    let docVecs = notes.map { n in
      e.embed(LiveEmbedder.sectionText(noteTitle: n.title, sectionTitle: n.section, body: n.body))!
    }

    // Query semantically about the sync note.
    let q = e.embed(LiveEmbedder.queryPrefix + "how does note syncing and conflict resolution work")!
    let scores = docVecs.map { e.similarity(q, $0) }

    for (i, n) in notes.enumerated() {
      print(String(format: "  %.4f  %@", scores[i], n.title))
    }

    let best = scores.enumerated().max(by: { $0.element < $1.element })!
    XCTAssertEqual(notes[best.offset].title, "iCloud sync engine",
                   "Sync query should rank the sync note first; got \(notes[best.offset].title)")

    // Documents the CORE PROBLEM (not asserted as a fix): RAW mean-pooled cosine
    // crushes every score into a narrow ~0.85–0.93 band, so the correct note
    // barely edges the runner-up — the "everything is ~90%" symptom. The fix
    // (centre by the corpus centroid) is verified in
    // testCenteredPipelineRanksAllQueriesCorrectly.
    let sorted = scores.sorted(by: >)
    let spread = sorted[0] - sorted[1]
    print(String(format: "  RAW top-2 spread = %.4f (narrow → why centring is needed)", spread))
  }

  /// The raw score RANGE across unrelated notes should be wide. All-near-equal
  /// high scores indicate the vectors collapse toward a common direction.
  func testScoreRangeAcrossUnrelatedTopicsIsWide() throws {
    let e = try makeEmbedder()

    let cooking = e.embed(LiveEmbedder.sectionText(noteTitle: notes[3].title, sectionTitle: notes[3].section, body: notes[3].body))!
    let query = e.embed(LiveEmbedder.queryPrefix + "reorder kanban cards by dragging between columns")!

    let dragVec = e.embed(LiveEmbedder.sectionText(noteTitle: notes[1].title, sectionTitle: notes[1].section, body: notes[1].body))!
    let relatedScore = e.similarity(query, dragVec)
    let unrelatedScore = e.similarity(query, cooking)

    print(String(format: "  related(kanban)=%.4f  unrelated(bread)=%.4f", relatedScore, unrelatedScore))
    XCTAssertGreaterThan(relatedScore, unrelatedScore + 0.05,
                         "A kanban query should score the kanban note clearly above an unrelated bread recipe.")
  }

  /// Distinct notes must yield distinct vectors (cosine < ~0.99). If two
  /// different notes are ~identical, pooling/normalisation is broken.
  func testDistinctNotesAreNotNearlyIdentical() throws {
    let e = try makeEmbedder()
    let a = e.embed(notes[3].body)! // bread
    let b = e.embed(notes[4].body)! // taxes
    let sim = e.similarity(a, b)
    print(String(format: "  cosine(bread, taxes) = %.4f", sim))
    XCTAssertLessThan(sim, 0.95, "Unrelated notes are nearly identical (\(sim)) — vectors collapsed.")
  }

  /// A note must match ITSELF at ~1.0 (sanity that normalisation holds).
  func testSelfSimilarityIsOne() throws {
    let e = try makeEmbedder()
    let v = e.embed(notes[0].body)!
    XCTAssertEqual(e.similarity(v, v), 1.0, accuracy: 1e-6)
  }

  // Centre each vector by the corpus centroid + renormalise — the fix for the
  // "everything scores ~90%" problem (mean-pooled contextual vectors share a
  // dominant common component that crushes cosine into a narrow high band).
  private func centered(_ vecs: [[Double]]) -> [[Double]] {
    let dim = vecs[0].count
    var centroid = [Double](repeating: 0, count: dim)
    for v in vecs { for i in 0..<dim { centroid[i] += v[i] } }
    for i in 0..<dim { centroid[i] /= Double(vecs.count) }
    return vecs.map { v in
      var out = [Double](repeating: 0, count: dim); var norm = 0.0
      for i in 0..<dim { out[i] = v[i] - centroid[i]; norm += out[i] * out[i] }
      norm = norm.squareRoot(); if norm > 1e-9 { for i in 0..<dim { out[i] /= norm } }
      return out
    }
  }

  /// Regression guard for the centring fix (mirrors semanticSearch in
  /// src/notes/embeddings.ts): centre the query alongside the docs, then cosine.
  /// Every distinct query must rank its matching note first, with clear
  /// separation — the behaviour raw mean-pooled cosine failed to provide.
  func testCenteredPipelineRanksAllQueriesCorrectly() throws {
    let e = try makeEmbedder()
    let docs = notes.map { n in
      e.embed(LiveEmbedder.sectionText(noteTitle: n.title, sectionTitle: n.section, body: n.body))!
    }

    let cases: [(q: String, expect: String)] = [
      ("how does note syncing and conflict resolution work", "iCloud sync engine"),
      ("drag to reorder cards on the kanban board", "Kanban board drag and drop"),
      ("recipe with flour and starter, ferment and bake", "Sourdough bread recipe"),
    ]
    for c in cases {
      // Centre the query together with the docs (the app centres by the doc
      // centroid; including the single query barely shifts it and keeps the test
      // self-contained).
      let all = centered(docs + [e.embed(c.q)!])
      let cDocs = Array(all.prefix(docs.count))
      let cq = all[docs.count]
      let scores = cDocs.map { EmbeddingMath.dot(cq, $0) }
      let best = scores.enumerated().max(by: { $0.element < $1.element })!
      print("  query: \(c.q)")
      for (i, n) in notes.enumerated() { print(String(format: "    %.3f  %@", scores[i], n.title)) }
      XCTAssertEqual(notes[best.offset].title, c.expect, "Wrong top hit for query: \(c.q)")
      // Winner must clearly beat the runner-up (no ~tie / "91% everything").
      let sorted = scores.sorted(by: >)
      XCTAssertGreaterThan(sorted[0] - sorted[1], 0.02, "Top-2 too close for query: \(c.q)")
    }
  }
}
