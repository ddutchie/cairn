import { describe, it, expect } from "vitest";
import path from "node:path";
import { assertSafeId, isSafeId, resolveWithinRoot } from "./path-safety";

describe("assertSafeId", () => {
  it("accepts the id shapes Cairn / dsh actually mint", () => {
    for (const id of [
      "thr-XyZ_123",
      "chat-thr-abc",
      "chat-thr-abc-1735000000000-abcd1234",
      "pi-Nb01",
      "bb4c63a3-3f4d-4e2b-9c1a-abcdef012345", // subagent uuid
      "abc",
      "a".repeat(128),
    ]) {
      expect(() => assertSafeId(id), id).not.toThrow();
    }
  });

  it("rejects path-traversal ids", () => {
    for (const id of ["..", "../", "../../etc/passwd", "chat/../..", "chat\\..", "chat\x00null"]) {
      expect(() => assertSafeId(id), id).toThrow(/unsafe/);
    }
  });

  it("rejects wrong types, empty, over-length, and disallowed chars", () => {
    for (const id of ["", "a".repeat(129), " ", "with space", "chat/thread", "chat|pipe", null, undefined, 42, {}, []]) {
      expect(() => assertSafeId(id as unknown), String(id)).toThrow(/unsafe/);
    }
  });
});

describe("isSafeId", () => {
  it("mirrors assertSafeId as a predicate", () => {
    expect(isSafeId("thr-abc")).toBe(true);
    expect(isSafeId("../evil")).toBe(false);
    expect(isSafeId(null)).toBe(false);
    expect(isSafeId(42)).toBe(false);
  });
});

describe("resolveWithinRoot", () => {
  const root = path.resolve("/tmp/cairn-safety-test");

  it("returns the resolved path when composed segments stay inside root", () => {
    expect(resolveWithinRoot(root, "sess1", "session.jsonl")).toBe(
      path.join(root, "sess1", "session.jsonl"),
    );
    expect(resolveWithinRoot(root, "a", "b", "c")).toBe(path.join(root, "a", "b", "c"));
  });

  it("returns null on parent-directory escape", () => {
    expect(resolveWithinRoot(root, "..", "evil")).toBeNull();
    expect(resolveWithinRoot(root, "sess", "..", "..", "evil")).toBeNull();
    expect(resolveWithinRoot(root, "..")).toBeNull();
  });

  it("returns null on absolute-path segments (path.resolve treats them as new roots)", () => {
    expect(resolveWithinRoot(root, "/etc/passwd")).toBeNull();
    expect(resolveWithinRoot(root, "sess", "/etc/passwd")).toBeNull();
  });

  it("accepts the root itself as a legitimate resolution", () => {
    expect(resolveWithinRoot(root)).toBe(root);
    expect(resolveWithinRoot(root, ".")).toBe(root);
  });

  it("handles a root that already ends in a separator", () => {
    const rootSep = root + path.sep;
    expect(resolveWithinRoot(rootSep, "sess1")).toBe(path.join(root, "sess1"));
    expect(resolveWithinRoot(rootSep, "..")).toBeNull();
  });

  it("rejects an escape that lands on a sibling with a common prefix", () => {
    // e.g. root = /tmp/cairn-safety-test; sibling /tmp/cairn-safety-test-evil
    // must NOT pass the containment check even though its string starts with
    // the root string.
    const composed = path.resolve(root, "..", path.basename(root) + "-evil");
    // Sanity: composed does start with root (as a raw string), but not with root+sep.
    expect(composed.startsWith(root)).toBe(true);
    expect(composed.startsWith(root + path.sep)).toBe(false);
    expect(resolveWithinRoot(root, "..", path.basename(root) + "-evil")).toBeNull();
  });
});
