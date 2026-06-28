/**
 * Unit tests for Kanban column WIP-limit logic (column-utils.ts).
 *
 * parseWipLimit was previously duplicated across two dialog call sites; these
 * tests pin the blank/invalid/positive behavior in one place. isAtWipLimit
 * gates the add-card button and over-limit banner — its null/0 and >= boundary
 * are the kind of thing that breaks subtly on edits.
 */

import { describe, it, expect } from "vitest";
import { parseWipLimit, isAtWipLimit } from "./column-utils";

describe("parseWipLimit", () => {
  it("returns null for blank or whitespace input", () => {
    expect(parseWipLimit("")).toBeNull();
    expect(parseWipLimit("   ")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseWipLimit("abc")).toBeNull();
  });

  it("returns null for zero and negative numbers", () => {
    expect(parseWipLimit("0")).toBeNull();
    expect(parseWipLimit("-3")).toBeNull();
  });

  it("parses a positive integer", () => {
    expect(parseWipLimit("5")).toBe(5);
    expect(parseWipLimit(" 12 ")).toBe(12);
  });

  it("rejects trailing-garbage / non-integer strings (must not truncate like parseInt)", () => {
    // parseInt would silently accept these and save a value the user never
    // typed; parseWipLimit must reject anything that isn't a whole integer.
    expect(parseWipLimit("3 cards")).toBeNull();
    expect(parseWipLimit("3.5")).toBeNull();
    expect(parseWipLimit("1e3")).toBeNull();
    expect(parseWipLimit("0x10")).toBeNull();
  });
});

describe("isAtWipLimit", () => {
  it("is false when there is no limit (null/undefined/0)", () => {
    expect(isAtWipLimit(null, 99)).toBe(false);
    expect(isAtWipLimit(undefined, 99)).toBe(false);
    expect(isAtWipLimit(0, 99)).toBe(false);
  });

  it("is false below the limit", () => {
    expect(isAtWipLimit(3, 2)).toBe(false);
  });

  it("is true at exactly the limit (>=)", () => {
    expect(isAtWipLimit(3, 3)).toBe(true);
  });

  it("is true over the limit", () => {
    expect(isAtWipLimit(3, 5)).toBe(true);
  });
});
