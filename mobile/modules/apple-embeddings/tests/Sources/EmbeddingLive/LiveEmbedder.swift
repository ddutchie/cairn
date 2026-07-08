import Foundation
import NaturalLanguage
import EmbeddingMath

/// A thin wrapper around NLContextualEmbedding that replicates the app's
/// embedding pipeline (see AppleEmbeddingsModule.swift + src/notes/embeddings.ts)
/// so tests can measure REAL on-device similarity scores against note text.
/// macOS 14+ ships the same models used on iOS 17+, so this runs under
/// `swift test` on a Mac.
@available(macOS 14.0, iOS 17.0, *)
public struct LiveEmbedder {
  public let embedding: NLContextualEmbedding
  public let dim: Int

  /// Query instruction prefix — mirrors QUERY_PREFIX in embeddings.ts.
  public static let queryPrefix = "Represent this sentence for searching relevant passages: "

  public init?() {
    guard let e = NLContextualEmbedding(language: .english) else { return nil }
    if !e.hasAvailableAssets {
      // Block on the async asset download so tests can run on a clean machine.
      let sem = DispatchSemaphore(value: 0)
      e.requestAssets { _, _ in sem.signal() }
      _ = sem.wait(timeout: .now() + 120)
    }
    guard e.hasAvailableAssets, (try? e.load()) != nil else { return nil }
    self.embedding = e
    self.dim = e.dimension
  }

  /// Embed a single string → mean-pooled, L2-normalised vector (same as the
  /// native module's embedBatch, one row).
  public func embed(_ raw: String) -> [Double]? {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty,
          let result = try? embedding.embeddingResult(for: text, language: .english)
    else { return nil }
    var tokens: [[Double]] = []
    result.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { v, _ in
      tokens.append(v)
      return true
    }
    return EmbeddingMath.poolAndNormalise(tokens, dim: dim)
  }

  /// The exact text the app embeds for a note section (mirrors sectionEmbedText).
  public static func sectionText(noteTitle: String, sectionTitle: String, body: String) -> String {
    "\(noteTitle)\n\n## \(sectionTitle)\n\(body)"
  }

  /// Cosine similarity (dot of two already-normalised vectors).
  public func similarity(_ a: [Double], _ b: [Double]) -> Double {
    EmbeddingMath.dot(a, b)
  }
}

// MARK: - Full-pipeline replica (matches src/notes/embeddings.ts)

/// A note section as produced by splitIntoSections.
public struct NoteSection {
  public let title: String
  public let text: String
}

/// A raw note row exported from the app DB (id/title/content markdown).
public struct RawNote: Decodable {
  public let id: String
  public let title: String
  public let content: String
}

/// Faithful Swift port of the app's markdown pipeline + centring search, so a
/// test can run the EXACT algorithm the device runs, on the EXACT note text.
public enum Pipeline {
  /// Port of splitIntoSections in embeddings.ts: split on `#`/`##` headers.
  public static func splitIntoSections(noteTitle: String, content: String) -> [NoteSection] {
    let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return [] }
    var sections: [NoteSection] = []
    var currentTitle = noteTitle.isEmpty ? "Untitled" : noteTitle
    var currentLines: [String] = []
    func flush() {
      let text = currentLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty { sections.append(NoteSection(title: currentTitle, text: text)) }
    }
    for line in trimmed.components(separatedBy: "\n") {
      // Match ^(#{1,6})\s+(.+)$ but only split on level 1–2 headers.
      if let hashRange = line.range(of: "^#{1,6}\\s+", options: .regularExpression) {
        let hashes = line[line.startIndex..<hashRange.upperBound].prefix { $0 == "#" }.count
        if hashes <= 2 {
          flush()
          currentTitle = String(line[hashRange.upperBound...]).trimmingCharacters(in: .whitespaces)
          currentLines = []
          continue
        }
      }
      currentLines.append(line)
    }
    flush()
    if sections.isEmpty { sections.append(NoteSection(title: noteTitle.isEmpty ? "Untitled" : noteTitle, text: trimmed)) }
    return sections
  }

  /// Centre a vector by the corpus centroid and renormalise (matches
  /// centerAndNormalise in embeddings.ts).
  public static func centerAndNormalise(_ v: [Double], centroid: [Double]) -> [Double] {
    var out = [Double](repeating: 0, count: v.count)
    var norm = 0.0
    for i in 0..<v.count { out[i] = v[i] - centroid[i]; norm += out[i] * out[i] }
    norm = norm.squareRoot()
    if norm > 1e-9 { for i in 0..<out.count { out[i] /= norm } }
    return out
  }
}

