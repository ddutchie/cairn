import XCTest
@testable import EmbeddingMath

/// Unit tests for the pure embedding math that backs on-device semantic search.
/// These guard the invariants search relies on: pooled vectors are L2-normalised
/// (so cosine == dot), identical text yields identical vectors, and the pooling
/// is order-independent + robust to odd-width rows.
final class EmbeddingMathTests: XCTestCase {

  private let eps = 1e-9

  // MARK: poolAndNormalise

  func testPoolMeansThenNormalisesToUnitLength() {
    // Two token vectors → mean is (2,0,0); normalised → (1,0,0).
    let pooled = EmbeddingMath.poolAndNormalise([[1, 0, 0], [3, 0, 0]], dim: 3)
    XCTAssertNotNil(pooled)
    XCTAssertEqual(EmbeddingMath.magnitude(pooled!), 1.0, accuracy: 1e-9)
    XCTAssertEqual(pooled![0], 1.0, accuracy: 1e-9)
    XCTAssertEqual(pooled![1], 0.0, accuracy: 1e-9)
  }

  func testPooledVectorIsAlwaysUnitLength() {
    let pooled = EmbeddingMath.poolAndNormalise([[1, 2, 3, 4], [5, 6, 7, 8]], dim: 4)
    XCTAssertNotNil(pooled)
    XCTAssertEqual(EmbeddingMath.magnitude(pooled!), 1.0, accuracy: 1e-9)
  }

  func testEmptyInputReturnsNil() {
    XCTAssertNil(EmbeddingMath.poolAndNormalise([], dim: 4))
  }

  func testAllZeroVectorsProducesZeroVectorNotNaN() {
    // Norm is ~0 → we must NOT divide (would be NaN). Expect a finite zero vec.
    let pooled = EmbeddingMath.poolAndNormalise([[0, 0, 0], [0, 0, 0]], dim: 3)
    XCTAssertNotNil(pooled)
    for x in pooled! { XCTAssertTrue(x.isFinite); XCTAssertEqual(x, 0.0, accuracy: eps) }
  }

  func testMismatchedWidthRowsAreIgnored() {
    // Only the width-3 rows count; the width-2 row is skipped.
    let pooled = EmbeddingMath.poolAndNormalise([[1, 0, 0], [9, 9], [3, 0, 0]], dim: 3)
    XCTAssertNotNil(pooled)
    XCTAssertEqual(pooled![0], 1.0, accuracy: 1e-9) // mean of (1,3) normalised
    XCTAssertEqual(EmbeddingMath.magnitude(pooled!), 1.0, accuracy: 1e-9)
  }

  func testAllMismatchedWidthReturnsNil() {
    XCTAssertNil(EmbeddingMath.poolAndNormalise([[1, 2], [3, 4, 5, 6]], dim: 3))
  }

  func testPoolingIsOrderIndependent() {
    let a = EmbeddingMath.poolAndNormalise([[1, 2, 3], [4, 5, 6], [7, 8, 9]], dim: 3)!
    let b = EmbeddingMath.poolAndNormalise([[7, 8, 9], [1, 2, 3], [4, 5, 6]], dim: 3)!
    for i in 0..<3 { XCTAssertEqual(a[i], b[i], accuracy: 1e-12) }
  }

  func testIdenticalInputYieldsIdenticalVector() {
    // The invariant that makes content-hash caching safe: same text in → same
    // vector out (so an unchanged section is correctly skipped on reindex).
    let v1 = EmbeddingMath.poolAndNormalise([[0.3, 0.7, 0.2, 0.9]], dim: 4)!
    let v2 = EmbeddingMath.poolAndNormalise([[0.3, 0.7, 0.2, 0.9]], dim: 4)!
    XCTAssertEqual(v1, v2)
  }

  // MARK: dot / cosine

  func testDotOfIdenticalUnitVectorsIsOne() {
    let v = EmbeddingMath.poolAndNormalise([[1, 2, 3, 4]], dim: 4)!
    XCTAssertEqual(EmbeddingMath.dot(v, v), 1.0, accuracy: 1e-9)
  }

  func testDotOfOrthogonalUnitVectorsIsZero() {
    let a = EmbeddingMath.poolAndNormalise([[1, 0, 0]], dim: 3)!
    let b = EmbeddingMath.poolAndNormalise([[0, 1, 0]], dim: 3)!
    XCTAssertEqual(EmbeddingMath.dot(a, b), 0.0, accuracy: 1e-9)
  }

  func testDotOfOppositeUnitVectorsIsMinusOne() {
    let a = EmbeddingMath.poolAndNormalise([[1, 1, 0]], dim: 3)!
    let b = EmbeddingMath.poolAndNormalise([[-1, -1, 0]], dim: 3)!
    XCTAssertEqual(EmbeddingMath.dot(a, b), -1.0, accuracy: 1e-9)
  }

  func testSimilarVectorsScoreHigherThanDissimilar() {
    // Sanity: the ranking property search depends on.
    let query = EmbeddingMath.poolAndNormalise([[1, 1, 0, 0]], dim: 4)!
    let near = EmbeddingMath.poolAndNormalise([[1, 0.9, 0.1, 0]], dim: 4)!
    let far = EmbeddingMath.poolAndNormalise([[0, 0, 1, 1]], dim: 4)!
    XCTAssertGreaterThan(EmbeddingMath.dot(query, near), EmbeddingMath.dot(query, far))
  }

  func testDotLengthMismatchIsZero() {
    XCTAssertEqual(EmbeddingMath.dot([1, 2, 3], [1, 2]), 0.0)
  }
}
