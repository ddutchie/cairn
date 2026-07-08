import Foundation

/// Pure, dependency-free embedding math shared by the native module. Kept
/// separate from AppleEmbeddingsModule (which needs ExpoModulesCore +
/// NaturalLanguage) so it can be unit-tested in a plain SwiftPM target — see
/// modules/apple-embeddings/tests/. Do NOT import ExpoModulesCore or
/// NaturalLanguage here.
public enum EmbeddingMath {
  /// Mean-pool a list of equal-length token vectors, then L2-normalise the
  /// result so downstream cosine similarity reduces to a dot product. Returns
  /// nil when there are no vectors to pool. Vectors whose length != `dim` are
  /// ignored (defensive: the model occasionally yields odd-width rows).
  public static func poolAndNormalise(_ vectors: [[Double]], dim: Int) -> [Double]? {
    var acc = [Double](repeating: 0, count: dim)
    var count = 0
    for v in vectors where v.count == dim {
      for d in 0..<dim { acc[d] += v[d] }
      count += 1
    }
    if count == 0 { return nil }

    var norm = 0.0
    for d in 0..<dim {
      acc[d] /= Double(count)
      norm += acc[d] * acc[d]
    }
    norm = norm.squareRoot()
    if norm > 1e-9 {
      for d in 0..<dim { acc[d] /= norm }
    }
    return acc
  }

  /// Dot product of two equal-length vectors. For L2-normalised inputs this is
  /// the cosine similarity. Returns 0 on a length mismatch.
  public static func dot(_ a: [Double], _ b: [Double]) -> Double {
    guard a.count == b.count else { return 0 }
    var s = 0.0
    for i in 0..<a.count { s += a[i] * b[i] }
    return s
  }

  /// L2 magnitude of a vector.
  public static func magnitude(_ v: [Double]) -> Double {
    var s = 0.0
    for x in v { s += x * x }
    return s.squareRoot()
  }
}
