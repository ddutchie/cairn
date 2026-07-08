// swift-tools-version:5.9
import PackageDescription

// Standalone SwiftPM package for the apple-embeddings native module.
//
//   cd modules/apple-embeddings/tests && swift test
//
// Two layers:
//  - EmbeddingMath      : pure math (pool + normalise + dot), no system deps.
//                         Source is a symlink to ../ios/EmbeddingMath.swift.
//  - EmbeddingLive      : wraps NLContextualEmbedding (NaturalLanguage) to
//                         replicate the app's real embedding pipeline, so tests
//                         can measure ACTUAL on-device similarity scores
//                         (macOS 14+ ships the same models as iOS 17+).
let package = Package(
  name: "EmbeddingMath",
  platforms: [.macOS(.v14)],
  targets: [
    .target(name: "EmbeddingMath", path: "Sources/EmbeddingMath"),
    .testTarget(
      name: "EmbeddingMathTests",
      dependencies: ["EmbeddingMath"],
      path: "Tests/EmbeddingMathTests"
    ),
    .target(name: "EmbeddingLive", dependencies: ["EmbeddingMath"], path: "Sources/EmbeddingLive"),
    .testTarget(
      name: "EmbeddingLiveTests",
      dependencies: ["EmbeddingLive", "EmbeddingMath"],
      path: "Tests/EmbeddingLiveTests",
      // Only the committed sample is a declared resource (SwiftPM errors on a
      // missing declared resource). The gitignored real_notes.json — generated
      // by scripts/export-notes-fixture.sh — is loaded from disk at test time
      // when present; otherwise the tests fall back to the sample.
      resources: [.copy("Fixtures/sample_notes.json")]
    ),
  ]
)
