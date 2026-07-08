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

  /// Does the BGE query prefix help or hurt on Apple's model, WITH centring in
  /// place? Compares mean top-2 spread across all queries, prefix vs raw query.
  /// The prefix is a foreign-model instruction that adds a shared boilerplate
  /// direction to every query — the same common-component that centring fights —
  /// so it may erode discrimination. This test decides empirically.
  func testCenteredPipelinePrefixVsNoPrefix() throws {
    let e = try makeEmbedder()
    let docs = notes.map { n in
      e.embed(LiveEmbedder.sectionText(noteTitle: n.title, sectionTitle: n.section, body: n.body))!
    }
    let cases: [(q: String, expect: String)] = [
      ("how does note syncing and conflict resolution work", "iCloud sync engine"),
      ("drag to reorder cards on the kanban board", "Kanban board drag and drop"),
      ("recipe with flour and starter, ferment and bake", "Sourdough bread recipe"),
    ]

    func run(prefix: String, label: String) -> (spread: Double, allCorrect: Bool) {
      var spreadSum = 0.0
      var allCorrect = true
      print("  --- \(label) ---")
      for c in cases {
        let all = centered(docs + [e.embed(prefix + c.q)!])
        let cDocs = Array(all.prefix(docs.count))
        let cq = all[docs.count]
        let scores = cDocs.map { EmbeddingMath.dot(cq, $0) }
        let best = scores.enumerated().max(by: { $0.element < $1.element })!
        let sorted = scores.sorted(by: >)
        let spread = sorted[0] - sorted[1]
        spreadSum += spread
        if notes[best.offset].title != c.expect { allCorrect = false }
        print(String(format: "    spread=%.4f top=%@ (want %@)", spread, notes[best.offset].title, c.expect))
      }
      return (spreadSum / Double(cases.count), allCorrect)
    }

    let withPrefix = run(prefix: LiveEmbedder.queryPrefix, label: "WITH BGE prefix")
    let noPrefix = run(prefix: "", label: "NO prefix")
    print(String(format: "  mean spread: withPrefix=%.4f  noPrefix=%.4f", withPrefix.spread, noPrefix.spread))
    print("  allCorrect: withPrefix=\(withPrefix.allCorrect) noPrefix=\(noPrefix.allCorrect)")
  }

  // MARK: - Real DB corpus

  /// Load the note corpus. Prefers the gitignored real_notes.json (your full
  /// cairn.db export via scripts/export-notes-fixture.sh) sitting next to this
  /// file; falls back to the committed anonymised sample_notes.json so the test
  /// always runs on any machine / CI.
  private func loadRealNotes() throws -> (notes: [RawNote], usingReal: Bool) {
    // real_notes.json lives beside this source file (Fixtures/ subdir).
    let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let realURL = here.appendingPathComponent("Fixtures/real_notes.json")
    if FileManager.default.fileExists(atPath: realURL.path) {
      let notes = try JSONDecoder().decode([RawNote].self, from: Data(contentsOf: realURL))
      if !notes.isEmpty { return (notes, true) }
    }
    guard let url = Bundle.module.url(forResource: "sample_notes", withExtension: "json") else {
      throw XCTSkip("no notes fixture available")
    }
    return (try JSONDecoder().decode([RawNote].self, from: Data(contentsOf: url)), false)
  }

  /// A pre-embedded corpus: one entry per note SECTION (best-per-note is taken
  /// at query time, matching semanticSearch).
  private struct Corpus {
    let sectionVecs: [(noteId: String, title: String, vec: [Double])]
    let centroid: [Double]
  }

  private func embedCorpus(_ e: LiveEmbedder, _ notes: [RawNote]) -> Corpus {
    var sectionVecs: [(noteId: String, title: String, vec: [Double])] = []
    for n in notes {
      for sec in Pipeline.splitIntoSections(noteTitle: n.title, content: n.content) {
        let text = LiveEmbedder.sectionText(noteTitle: n.title, sectionTitle: sec.title, body: sec.text)
        if let v = e.embed(text) { sectionVecs.append((n.id, n.title, v)) }
      }
    }
    let dim = e.dim
    var centroid = [Double](repeating: 0, count: dim)
    for s in sectionVecs { for i in 0..<dim { centroid[i] += s.vec[i] } }
    for i in 0..<dim { centroid[i] /= Double(sectionVecs.count) }
    return Corpus(sectionVecs: sectionVecs, centroid: centroid)
  }

  /// Run the exact centring search and return ranked (title, score) best-per-note.
  private func search(_ e: LiveEmbedder, _ corpus: Corpus, query: String) -> [(title: String, score: Double)] {
    let cq = Pipeline.centerAndNormalise(e.embed(query)!, centroid: corpus.centroid)
    var best: [String: (title: String, score: Double)] = [:]
    for s in corpus.sectionVecs {
      let score = EmbeddingMath.dot(cq, Pipeline.centerAndNormalise(s.vec, centroid: corpus.centroid))
      if let prev = best[s.noteId], prev.score >= score { continue }
      best[s.noteId] = (s.title, score)
    }
    return best.values.map { ($0.title, $0.score) }.sorted { $0.score > $1.score }
  }

  /// The APP's hybrid re-rank (mirrors semanticSearch in embeddings.ts): blend
  /// min-max-normalised centred cosine with a title-weighted lexical score at
  /// SEMANTIC_WEIGHT. Returns note ids ranked best-first.
  private func hybridRanked(_ e: LiveEmbedder, _ corpus: Corpus, _ notes: [RawNote],
                            query: String, semanticWeight: Double = 0.5) -> [String] {
    var titleById: [String: String] = [:], bodyById: [String: String] = [:]
    for n in notes { titleById[n.id] = n.title; bodyById[n.id] = n.content }
    let cq = Pipeline.centerAndNormalise(e.embed(query)!, centroid: corpus.centroid)
    var sem: [String: Double] = [:]
    for s in corpus.sectionVecs {
      let score = EmbeddingMath.dot(cq, Pipeline.centerAndNormalise(s.vec, centroid: corpus.centroid))
      sem[s.noteId] = max(sem[s.noteId] ?? -2, score)
    }
    let lo = sem.values.min() ?? 0, hi = sem.values.max() ?? 1
    let span = max(hi - lo, 1e-6)
    return sem.map { (id, s) -> (id: String, score: Double) in
      let semN = (s - lo) / span
      let lex = titleWeightedLexical(query: query, title: titleById[id] ?? "", body: bodyById[id] ?? "")
      return (id, semanticWeight * semN + (1 - semanticWeight) * lex)
    }.sorted { $0.score > $1.score }.map { $0.id }
  }

  /// THE reported bug, tested against the REAL 70-note corpus with the app's
  /// HYBRID pipeline: searching "How does semantic search work" must rank the
  /// on-device-semantic-search note first. Prints both the pure-semantic and
  /// hybrid rankings so a regression is easy to diagnose.
  func testRealCorpusRanksSemanticSearchNoteForItsQuery() throws {
    let e = try makeEmbedder()
    let (notes, usingReal) = try loadRealNotes()
    print("  loaded \(notes.count) notes (\(usingReal ? "REAL cairn.db export" : "committed sample"))")
    let corpus = embedCorpus(e, notes)
    print("  embedded \(corpus.sectionVecs.count) sections")

    let query = "How does semantic search work"

    // Pure semantic (what pure cosine does — for the diagnostic print).
    let pure = search(e, corpus, query: query)
    let pureRank = (pure.firstIndex { $0.title.lowercased().contains("semantic search") } ?? -1) + 1
    print("  pure-semantic rank of semantic-search note: \(pureRank) of \(pure.count)")

    // Hybrid (what the app now does).
    let idByTitle = Dictionary(notes.map { ($0.title, $0.id) }, uniquingKeysWith: { a, _ in a })
    let wantId = idByTitle.first { $0.key.lowercased().contains("semantic search") }?.value
    let ranked = hybridRanked(e, corpus, notes, query: query)
    print("  === hybrid ranking (top 5) for: \(query) ===")
    for (i, id) in ranked.prefix(5).enumerated() {
      let title = notes.first { $0.id == id }?.title ?? id
      print(String(format: "    %2d. %@", i + 1, title))
    }
    let hybridRank = (ranked.firstIndex { $0 == wantId } ?? -1) + 1
    print("  hybrid rank of semantic-search note: \(hybridRank) of \(ranked.count)")
    XCTAssertEqual(hybridRank, 1, "Hybrid search should rank the semantic-search note #1 for its own query")
  }

  /// Broader probe: several natural queries against the real corpus with the
  /// hybrid pipeline. Every query whose target note exists should rank it #1.
  func testRealCorpusMultiQueryDiagnostic() throws {
    let e = try makeEmbedder()
    let (notes, usingReal) = try loadRealNotes()
    let corpus = embedCorpus(e, notes)

    // (query, substring of the expected note's title). Only queries with a
    // clear single target are asserted. Skipped if the corpus has no such note
    // (e.g. the sample lacks a sync note under this exact title).
    let cases: [(q: String, expect: String)] = [
      ("How does semantic search work", "semantic search"),
      ("on-device embeddings apple", "semantic search"),
      ("sync conflict resolution", "sync"),
    ]
    // The real corpus is where correctness matters (strict #1). The tiny sample
    // is only a smoke test — 8 notes don't separate as cleanly — so allow top-3.
    let maxRank = usingReal ? 1 : 3
    for c in cases {
      // Candidate target notes: any whose title contains the expected term
      // (there can be several, e.g. multiple "Sync …" notes). We check that the
      // BEST-ranked such note lands within maxRank — i.e. a relevant note
      // surfaces at the top, which is the actual UX guarantee.
      let wantIds = Set(notes.filter { $0.title.lowercased().contains(c.expect) }.map { $0.id })
      guard !wantIds.isEmpty else {
        print("  (skip) no target note for: \(c.q)")
        continue
      }
      let ranked = hybridRanked(e, corpus, notes, query: c.q)
      let bestRank = (ranked.firstIndex { wantIds.contains($0) } ?? -1) + 1
      let top = notes.first { $0.id == ranked.first }?.title ?? "?"
      print(String(format: "  %-34@ → best target rank %d (top: %@)", c.q as NSString, bestRank, top as NSString))
      XCTAssertTrue(bestRank >= 1 && bestRank <= maxRank, "Best target rank \(bestRank) > \(maxRank) for: \(c.q)")
    }
  }

  // MARK: - Hybrid (lexical + semantic) experiment

  private static let stopwords: Set<String> = [
    "the", "and", "for", "how", "does", "did", "was", "were", "are", "you", "your",
    "with", "what", "why", "who", "can", "our", "this", "that", "into", "from",
    "work", "works", "use", "used", "using", "get", "got", "has", "have",
  ]

  /// Title-weighted lexical score: query keywords (stopwords removed) matched
  /// against the note TITLE count 2×, body 1×. This is what makes a note called
  /// literally "…semantic search" win the query "how does semantic search work".
  private func titleWeightedLexical(query: String, title: String, body: String) -> Double {
    let terms = Set(
      query.lowercased()
        .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        .map(String.init)
        .filter { $0.count > 2 && !Self.stopwords.contains($0) }
    )
    if terms.isEmpty { return 0 }
    let t = title.lowercased(), b = body.lowercased()
    var score = 0.0
    for term in terms {
      if t.contains(term) { score += 2 }
      else if b.contains(term) { score += 1 }
    }
    return score / (Double(terms.count) * 2) // 0..1
  }

  /// Experiment: blend centred-cosine with a lexical keyword score and measure
  /// how the correct note ranks for each query as we vary the blend weight.
  /// Pure semantic (alpha=1) is the current app behaviour; this shows whether a
  /// hybrid rescues the keyword-heavy queries that pure embeddings botch.
  func testHybridLexicalSemanticRanking() throws {
    let e = try makeEmbedder()
    let (notes, _) = try loadRealNotes()
    let corpus = embedCorpus(e, notes)
    // Map title → id so we can locate the expected note.
    let idByTitle = Dictionary(notes.map { ($0.title, $0.id) }, uniquingKeysWith: { a, _ in a })
    var titleById: [String: String] = [:], bodyById: [String: String] = [:]
    for n in notes { titleById[n.id] = n.title; bodyById[n.id] = n.content }

    let cases: [(q: String, expectContains: String)] = [
      ("How does semantic search work", "semantic search"),
      ("on-device embeddings apple", "semantic search"),
      ("kanban board columns", "kanban"),
      ("sync conflict resolution", "sync"),
    ]

    for alpha in [1.0, 0.7, 0.5, 0.3] {
      print(String(format: "  ===== alpha(semantic)=%.1f  beta(title-lexical)=%.1f =====", alpha, 1 - alpha))
      for c in cases {
        let cq = Pipeline.centerAndNormalise(e.embed(c.q)!, centroid: corpus.centroid)
        // best semantic per note
        var sem: [String: Double] = [:]
        for s in corpus.sectionVecs {
          let score = EmbeddingMath.dot(cq, Pipeline.centerAndNormalise(s.vec, centroid: corpus.centroid))
          sem[s.noteId] = max(sem[s.noteId] ?? -2, score)
        }
        // Normalise semantic to 0..1 across the corpus so it blends fairly with
        // the 0..1 lexical score.
        let lo = sem.values.min() ?? 0, hi = sem.values.max() ?? 1
        let span = max(hi - lo, 1e-6)
        let blended: [(id: String, score: Double)] = sem.map { (id, s) in
          let semN = (s - lo) / span
          let lex = titleWeightedLexical(query: c.q, title: titleById[id] ?? "", body: bodyById[id] ?? "")
          return (id, alpha * semN + (1 - alpha) * lex)
        }.sorted { $0.score > $1.score }
        let wantId = idByTitle.first { $0.key.lowercased().contains(c.expectContains) }?.value
        let rank = (blended.firstIndex { $0.id == wantId } ?? -1) + 1
        print(String(format: "    %-34@ → rank %d", c.q as NSString, rank))
      }
    }
  }
}
