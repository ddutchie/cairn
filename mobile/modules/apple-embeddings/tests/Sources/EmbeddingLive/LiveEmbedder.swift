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
