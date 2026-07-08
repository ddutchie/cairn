import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

#if canImport(FoundationModels)

/// Builds a FoundationModels `GenerationSchema` from a JSON Schema object (the
/// same `jsonSchema` shape Cairn's tools expose). Guided generation then
/// constrains the model to emit arguments matching this schema, so we never
/// parse free-form text for tool calls.
///
/// Adapted from callstack's @react-native-ai/apple schema parser. Supported:
/// objects, arrays (min/max items), strings (enum, pattern), numbers/integers
/// (min/max, exclusive bounds → nearest inclusive), booleans, and `anyOf`.
/// Unsupported JSON Schema features throw `AppleLlmSchemaError`.
@available(iOS 26.0, *)
enum AppleLlmSchemaParser {
  static func generationSchema(from schema: [String: Any]) throws -> GenerationSchema {
    let root = try dynamicSchema(from: schema)
    return try GenerationSchema(root: root, dependencies: [])
  }

  static func dynamicSchema(from schema: [String: Any]) throws -> DynamicGenerationSchema {
    // anyOf (union) — parse each branch.
    if let anyOf = schema["anyOf"] as? [[String: Any]] {
      let branches = try anyOf.map { try dynamicSchema(from: $0) }
      return DynamicGenerationSchema(
        name: schema["title"] as? String ?? "",
        description: schema["description"] as? String,
        anyOf: branches
      )
    }

    let type = schema["type"] as? String
    switch type {
    case "object": return try objectSchema(from: schema)
    case "array": return try arraySchema(from: schema)
    case "string": return stringSchema(from: schema)
    case "number", "integer": return numberSchema(from: schema, type: type ?? "number")
    case "boolean": return DynamicGenerationSchema(type: Bool.self, guides: [])
    default:
      throw AppleLlmSchemaError.unsupported(
        "Unsupported schema type: \(type ?? "unknown"). Supported: object, array, string, number, integer, boolean."
      )
    }
  }

  private static func objectSchema(from schema: [String: Any]) throws -> DynamicGenerationSchema {
    var properties: [DynamicGenerationSchema.Property] = []
    if let props = schema["properties"] as? [String: Any] {
      let required = schema["required"] as? [String] ?? []
      for (name, raw) in props {
        guard let propSchema = raw as? [String: Any] else {
          throw AppleLlmSchemaError.unsupported("Property \(name) schema must be an object.")
        }
        let nested = try dynamicSchema(from: propSchema)
        properties.append(
          DynamicGenerationSchema.Property(
            name: name,
            description: propSchema["description"] as? String,
            schema: nested,
            isOptional: !required.contains(name)
          )
        )
      }
    }
    return DynamicGenerationSchema(
      name: schema["title"] as? String ?? "",
      description: schema["description"] as? String,
      properties: properties
    )
  }

  private static func arraySchema(from schema: [String: Any]) throws -> DynamicGenerationSchema {
    guard let items = schema["items"] as? [String: Any] else {
      throw AppleLlmSchemaError.unsupported("Array schema must have an `items` definition.")
    }
    let itemSchema = try dynamicSchema(from: items)
    return DynamicGenerationSchema(
      arrayOf: itemSchema,
      minimumElements: schema["minItems"] as? Int,
      maximumElements: schema["maxItems"] as? Int
    )
  }

  private static func stringSchema(from schema: [String: Any]) -> DynamicGenerationSchema {
    if let values = schema["enum"] as? [String] {
      return DynamicGenerationSchema(type: String.self, guides: [GenerationGuide.anyOf(values)])
    }
    if let pattern = schema["pattern"] as? String, let regex = try? Regex(pattern) {
      return DynamicGenerationSchema(type: String.self, guides: [GenerationGuide.pattern(regex)])
    }
    return DynamicGenerationSchema(type: String.self, guides: [])
  }

  private static func numberSchema(from schema: [String: Any], type: String) -> DynamicGenerationSchema {
    let isInt = type == "integer"
    // Numeric enums: Apple's anyOf guide is String-only, so represent as strings;
    // the JS side coerces back to numbers after generation.
    if let values = schema["enum"] as? [String] {
      return DynamicGenerationSchema(type: String.self, guides: [GenerationGuide.anyOf(values)])
    }
    if let maximum = schema["maximum"] as? Double {
      return isInt
        ? DynamicGenerationSchema(type: Int.self, guides: [GenerationGuide.maximum(Int(maximum))])
        : DynamicGenerationSchema(type: Double.self, guides: [GenerationGuide.maximum(maximum)])
    }
    if let minimum = schema["minimum"] as? Double {
      return isInt
        ? DynamicGenerationSchema(type: Int.self, guides: [GenerationGuide.minimum(Int(minimum))])
        : DynamicGenerationSchema(type: Double.self, guides: [GenerationGuide.minimum(minimum)])
    }
    // Exclusive bounds → nearest inclusive (Apple only supports ≤ / ≥).
    if let exclusiveMax = schema["exclusiveMaximum"] as? Double {
      // Largest integer strictly below exclusiveMax: ceil(x)-1 handles both whole
      // (5.0 → 4) and fractional (5.5 → 5) bounds. Plain Int(x)-1 was wrong for
      // fractional values (5.5 → 4).
      return isInt
        ? DynamicGenerationSchema(type: Int.self, guides: [GenerationGuide.maximum(Int(exclusiveMax.rounded(.up)) - 1)])
        : DynamicGenerationSchema(type: Double.self, guides: [GenerationGuide.maximum(exclusiveMax.nextDown)])
    }
    if let exclusiveMin = schema["exclusiveMinimum"] as? Double {
      return isInt
        ? DynamicGenerationSchema(type: Int.self, guides: [GenerationGuide.minimum(Int(exclusiveMin) + 1)])
        : DynamicGenerationSchema(type: Double.self, guides: [GenerationGuide.minimum(exclusiveMin.nextUp)])
    }
    return isInt
      ? DynamicGenerationSchema(type: Int.self, guides: [])
      : DynamicGenerationSchema(type: Double.self, guides: [])
  }
}

enum AppleLlmSchemaError: Error {
  case unsupported(String)
}

#endif
