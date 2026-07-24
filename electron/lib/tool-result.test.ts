import { describe, it, expect } from "vitest";
import { toolResultError, isToolResultOk, resultContentError, externalOutputError } from "./tool-result";

describe("toolResultError", () => {
  it("returns the message for an object with a string error", () => {
    expect(toolResultError({ error: "Project not found" })).toBe("Project not found");
  });

  it("stringifies a structured error object", () => {
    const r = toolResultError({ error: "missing_required_field", field: "title" });
    // The `error` field itself is a string here → returned as-is.
    expect(r).toBe("missing_required_field");
  });

  it("stringifies a non-string error value", () => {
    expect(toolResultError({ error: { code: 42 } })).toBe(JSON.stringify({ code: 42 }));
  });

  it("returns undefined for a successful result object", () => {
    expect(toolResultError({ id: "n1", title: "X", action: "created" })).toBeUndefined();
  });

  it("treats empty/false/null error as success (not an error)", () => {
    expect(toolResultError({ error: "" })).toBeUndefined();
    expect(toolResultError({ error: false })).toBeUndefined();
    expect(toolResultError({ error: null })).toBeUndefined();
  });

  it("returns undefined for non-objects, arrays, and strings", () => {
    expect(toolResultError("plain output")).toBeUndefined();
    expect(toolResultError(["a", "b"])).toBeUndefined();
    expect(toolResultError(42)).toBeUndefined();
    expect(toolResultError(null)).toBeUndefined();
  });
});

describe("isToolResultOk", () => {
  it("is false when an error is present", () => {
    expect(isToolResultOk({ error: "nope" })).toBe(false);
  });
  it("is true for a clean result", () => {
    expect(isToolResultOk({ id: "n1" })).toBe(true);
    expect(isToolResultOk("some text output")).toBe(true);
  });
});

describe("resultContentError (serialised results)", () => {
  it("detects an error inside a JSON string", () => {
    expect(resultContentError(JSON.stringify({ error: "boom" }))).toBe("boom");
  });

  it("returns undefined for a successful JSON string", () => {
    expect(resultContentError(JSON.stringify({ id: "n1", title: "X" }))).toBeUndefined();
  });

  it("treats a plain-text (non-JSON) result as success", () => {
    expect(resultContentError("Wrote 42 lines to file.")).toBeUndefined();
    expect(resultContentError("")).toBeUndefined();
  });

  it("treats malformed JSON as success rather than throwing", () => {
    expect(resultContentError('{"error": ')).toBeUndefined();
  });
});

describe("externalOutputError (plain-string external tool output)", () => {
  it("detects the conventional Error: prefix", () => {
    expect(externalOutputError("Error: MCP server x is not enabled")).toBe("Error: MCP server x is not enabled");
    expect(externalOutputError("Error calling svc__x__y: boom")).toBe("Error calling svc__x__y: boom");
  });

  it("detects an Error prefix after leading whitespace", () => {
    expect(externalOutputError("  Error: nope")).toBe("Error: nope");
  });

  it("treats normal output as success (including text that merely contains 'error')", () => {
    expect(externalOutputError("Results: 3 items found")).toBeUndefined();
    expect(externalOutputError("The build had no errors")).toBeUndefined();
    expect(externalOutputError("")).toBeUndefined();
    expect(externalOutputError('{"ok":true}')).toBeUndefined();
  });
});
