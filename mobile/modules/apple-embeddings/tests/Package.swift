// swift-tools-version:5.9
import PackageDescription

// Standalone SwiftPM package that unit-tests the PURE embedding math
// (EmbeddingMath.swift) used by the native apple-embeddings Expo module,
// WITHOUT pulling in ExpoModulesCore or NaturalLanguage. Run with:
//
//   cd modules/apple-embeddings/tests && swift test
//
// Sources/EmbeddingMath/EmbeddingMath.swift is a SYMLINK to ../ios/EmbeddingMath.swift
// so there is a single source of truth for the math.
let package = Package(
  name: "EmbeddingMath",
  targets: [
    .target(name: "EmbeddingMath", path: "Sources/EmbeddingMath"),
    .testTarget(
      name: "EmbeddingMathTests",
      dependencies: ["EmbeddingMath"],
      path: "Tests/EmbeddingMathTests"
    ),
  ]
)
