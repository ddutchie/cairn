import ExpoModulesCore
import Foundation
import NaturalLanguage

// Stable public error codes mirrored on the JS side (AppleEmbeddingsErrorCodes).
private enum AppleEmbeddingsCode: String {
  case unsupported = "UNSUPPORTED"
  case assetsUnavailable = "ASSETS_UNAVAILABLE"
  case embedFailed = "EMBED_FAILED"
}

/// On-device text embeddings via NaturalLanguage's `NLContextualEmbedding`
/// (iOS 17+). A single BERT-style model produces per-subword-token vectors; we
/// mean-pool over tokens and L2-normalise to get one vector per input string,
/// matching the pooling/normalisation the desktop bge-small pipeline uses (so
/// the downstream cosine-search maths is identical, even though the vector
/// space itself differs and is never synced).
///
/// All API use is `@available(iOS 17.0, *)` gated so the binary loads on the
/// app's 16.4 deployment floor; callers must check `isAvailable()` first.
public class AppleEmbeddingsModule: Module {
  // The lazily-constructed English contextual embedding, plus a flag tracking
  // whether load()/asset-download has succeeded. Guarded by `lock` because Expo
  // async functions may run concurrently on a background queue.
  private var embeddingRef: AnyObject?
  private var loaded = false
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("AppleEmbeddings")

    // Synchronous readiness probes (safe to call from JS render paths).

    // "Can this device ever run on-device embeddings?" — true on iOS 17+ when a
    // contextual-embedding model constructs for the language, REGARDLESS of
    // whether its assets are downloaded yet (assets are fetched on demand via
    // ensureAssets/embed). Use this to decide whether to show semantic-search
    // UI; use isAvailable() for "can embed this instant".
    Function("isSupported") { () -> Bool in
      if #available(iOS 17.0, *) {
        return self.currentEmbedding() != nil
      }
      return false
    }

    Function("isAvailable") { () -> Bool in
      if #available(iOS 17.0, *) {
        return self.currentEmbedding()?.hasAvailableAssets ?? false
      }
      return false
    }

    Function("unavailableReason") { () -> String in
      if #available(iOS 17.0, *) {
        guard let e = self.currentEmbedding() else {
          return "No contextual embedding model is available for this language."
        }
        return e.hasAvailableAssets ? "" : "Embedding model assets aren't downloaded yet."
      }
      return "On-device embeddings require iOS 17 or later."
    }

    // Model metadata; the (modelIdentifier, revision, dimension) triple is the
    // index-invalidation key on the JS side.
    AsyncFunction("info") { () -> [String: Any] in
      if #available(iOS 17.0, *) {
        guard let e = self.currentEmbedding() else {
          throw Exception(name: AppleEmbeddingsCode.unsupported.rawValue,
                          description: "No contextual embedding model available.")
        }
        return [
          "dimension": e.dimension,
          "modelIdentifier": e.modelIdentifier,
          "revision": e.revision,
          "maximumSequenceLength": e.maximumSequenceLength,
        ]
      }
      throw Exception(name: AppleEmbeddingsCode.unsupported.rawValue,
                      description: "On-device embeddings require iOS 17 or later.")
    }

    // Download assets if needed and load the model. Idempotent.
    AsyncFunction("ensureAssets") { (promise: Promise) in
      if #available(iOS 17.0, *) {
        self.ensureLoaded { ok in promise.resolve(ok) }
      } else {
        promise.resolve(false)
      }
    }

    // Embed a batch → flat row-major [text0 dim floats, text1 dim floats, ...].
    AsyncFunction("embed") { (texts: [String]) -> [Double] in
      if #available(iOS 17.0, *) {
        return try self.embedBatch(texts)
      }
      throw Exception(name: AppleEmbeddingsCode.unsupported.rawValue,
                      description: "On-device embeddings require iOS 17 or later.")
    }
  }

  // MARK: - Model management

  @available(iOS 17.0, *)
  private func currentEmbedding() -> NLContextualEmbedding? {
    lock.lock()
    defer { lock.unlock() }
    if let e = embeddingRef as? NLContextualEmbedding { return e }
    // English model; the same object also covers several Latin-script languages.
    guard let e = NLContextualEmbedding(language: .english) else { return nil }
    embeddingRef = e
    return e
  }

  @available(iOS 17.0, *)
  private func ensureLoaded(_ completion: @escaping (Bool) -> Void) {
    guard let e = currentEmbedding() else { completion(false); return }
    if loadIfPossible(e) { completion(true); return }
    // Assets missing → request the on-device download, then retry load.
    e.requestAssets { [weak self] result, _ in
      guard let self else { completion(false); return }
      if result == .available, self.loadIfPossible(e) {
        completion(true)
      } else {
        completion(false)
      }
    }
  }

  @available(iOS 17.0, *)
  private func loadIfPossible(_ e: NLContextualEmbedding) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if loaded { return true }
    guard e.hasAvailableAssets else { return false }
    do {
      try e.load()
      loaded = true
      return true
    } catch {
      return false
    }
  }

  // MARK: - Embedding

  @available(iOS 17.0, *)
  private func embedBatch(_ texts: [String]) throws -> [Double] {
    guard let e = currentEmbedding() else {
      throw Exception(name: AppleEmbeddingsCode.unsupported.rawValue,
                      description: "No contextual embedding model available.")
    }
    guard loadIfPossible(e) else {
      throw Exception(name: AppleEmbeddingsCode.assetsUnavailable.rawValue,
                      description: "Embedding model assets aren't available on-device.")
    }
    let dim = e.dimension
    var out = [Double](repeating: 0, count: texts.count * dim)

    for (i, raw) in texts.enumerated() {
      let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty { continue } // leave zero vector

      let result: NLContextualEmbeddingResult
      do {
        result = try e.embeddingResult(for: text, language: .english)
      } catch {
        throw Exception(name: AppleEmbeddingsCode.embedFailed.rawValue,
                        description: "Failed to embed text: \(error.localizedDescription)")
      }

      // Mean-pool over subword-token vectors.
      var acc = [Double](repeating: 0, count: dim)
      var count = 0
      let full = text.startIndex..<text.endIndex
      result.enumerateTokenVectors(in: full) { vector, _ in
        if vector.count == dim {
          for d in 0..<dim { acc[d] += vector[d] }
          count += 1
        }
        return true
      }
      if count == 0 { continue }

      // Average, then L2-normalise (so downstream cosine == dot product).
      var norm = 0.0
      for d in 0..<dim {
        acc[d] /= Double(count)
        norm += acc[d] * acc[d]
      }
      norm = norm.squareRoot()
      let base = i * dim
      if norm > 1e-9 {
        for d in 0..<dim { out[base + d] = acc[d] / norm }
      } else {
        for d in 0..<dim { out[base + d] = acc[d] }
      }
    }
    return out
  }
}
