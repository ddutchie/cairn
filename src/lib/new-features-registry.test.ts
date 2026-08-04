/**
 * Unit tests for getUnseenLatestFeatures — the pure gate shared by
 * NewFeatureModal and the boot logic in page.tsx. It decides which features the
 * "What's New" modal surfaces (and whether the tour is deferred at boot).
 */

import { describe, expect, it } from "vitest";
import {
  getUnseenLatestFeatures,
  minorOf,
  NEW_FEATURES_REGISTRY,
  type NewFeature,
} from "./new-features-registry";

const feat = (id: string, version: string): NewFeature => ({
  id,
  version,
  title: `Feature ${id}`,
  category: "Test",
  description: "",
  highlights: [],
});

describe("minorOf", () => {
  it("reduces a patch tag to its minor line", () => {
    expect(minorOf("v2.6.1")).toBe("v2.6");
    expect(minorOf("v2.6.0")).toBe("v2.6");
    expect(minorOf("v2.5.x")).toBe("v2.5");
    expect(minorOf("v9.0")).toBe("v9.0");
  });

  it("reduces a condensed whole-major tag to its major line", () => {
    expect(minorOf("v0.x")).toBe("v0");
    expect(minorOf("v1.x")).toBe("v1");
  });
});

describe("getUnseenLatestFeatures", () => {
  it("returns the entire registry when forceOpen is true (Settings entrypoint)", () => {
    const registry = [feat("a", "v1.0.0"), feat("b", "v2.0.0")];
    expect(getUnseenLatestFeatures(registry, [], true)).toEqual(registry);
  });

  it("returns the entire registry when forceOpen is true even if all are seen", () => {
    const registry = [feat("a", "v1.0.0"), feat("b", "v2.0.0")];
    expect(getUnseenLatestFeatures(registry, ["a", "b"], true)).toEqual(registry);
  });

  it("returns [] for an empty registry", () => {
    expect(getUnseenLatestFeatures([], [])).toEqual([]);
  });

  it("returns only unseen features from the LATEST MINOR (all patches, not just the last patch)", () => {
    const registry = [
      feat("old", "v1.0.0"),
      feat("latest-1", "v2.0.0"),
      feat("latest-2", "v2.0.1"), // patch within the same minor
    ];
    // Nothing seen — both latest-minor features surface; the old one never does.
    const result = getUnseenLatestFeatures(registry, []);
    expect(result.map((f) => f.id)).toEqual(["latest-1", "latest-2"]);
  });

  it("ignores unseen features from OLDER minors", () => {
    const registry = [feat("old", "v1.0.0"), feat("latest", "v2.0.0")];
    // The old feature is unseen but belongs to a previous minor — excluded.
    const result = getUnseenLatestFeatures(registry, ["latest"]);
    expect(result).toEqual([]);
  });

  it("does not re-show features the user already saw in an earlier patch of the same minor", () => {
    const registry = [
      feat("seen-in-2.6.0", "v2.6.0"),
      feat("new-in-2.6.1", "v2.6.1"),
    ];
    // 2.6.0 was seen → only the 2.6.1 entry surfaces, exactly like the real
    // "saw 2.6.0, now 2.6.1 ships" upgrade path.
    const result = getUnseenLatestFeatures(registry, ["seen-in-2.6.0"]);
    expect(result.map((f) => f.id)).toEqual(["new-in-2.6.1"]);
  });

  it("never auto-shows a condensed older-minor card (vX.Y.x)", () => {
    const registry = [
      feat("v2.5.x", "v2.5.x"),
      feat("latest", "v2.6.0"),
    ];
    // The condensed card is unseen but belongs to an older minor — hidden at boot.
    const result = getUnseenLatestFeatures(registry, []);
    expect(result.map((f) => f.id)).toEqual(["latest"]);
  });

  it("excludes a condensed card even when it is the last (newest) registry entry", () => {
    // A condensed v0.x card sitting at the end must never auto-show, regardless
    // of registry order — its minor ("v0") must not match a gated minor.
    const registry = [
      feat("active", "v0.1.0"),
      feat("condensed", "v0.x"),
    ];
    const result = getUnseenLatestFeatures(registry, []);
    expect(result.map((f) => f.id)).toEqual(["active"]);
  });

  it("filters out already-seen features within the latest minor", () => {
    const registry = [
      feat("latest-1", "v2.0.0"),
      feat("latest-2", "v2.0.0"),
    ];
    const result = getUnseenLatestFeatures(registry, ["latest-1"]);
    expect(result.map((f) => f.id)).toEqual(["latest-2"]);
  });

  it("returns [] when every feature in the latest minor has been seen", () => {
    const registry = [
      feat("latest-1", "v2.0.0"),
      feat("latest-2", "v2.0.0"),
    ];
    expect(getUnseenLatestFeatures(registry, ["latest-1", "latest-2"])).toEqual([]);
  });

  it("derives the latest minor from the LAST registry entry, not by string comparison", () => {
    // The function trusts registry order: the latest minor is the last entry's
    // minor. A higher version number appearing earlier must NOT be treated as latest.
    const registry = [
      feat("higher-but-earlier", "v9.0.0"),
      feat("actual-latest", "v2.0.0"),
    ];
    const result = getUnseenLatestFeatures(registry, []);
    expect(result.map((f) => f.id)).toEqual(["actual-latest"]);
  });
});

// ── Real registry ordering invariant ──────────────────────────────────────────
// getUnseenLatestFeatures trusts registry ORDER (last entry = latest version).
// These checks tie that contract to the actual shared registry the modal and
// onboarding logic consume, so an out-of-order append is caught here.
describe("NEW_FEATURES_REGISTRY ordering invariant", () => {
  const toTuple = (version: string): number[] =>
    version.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);

  const cmp = (a: number[], b: number[]): number => {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };

  it("is non-empty and every entry has a unique id", () => {
    expect(NEW_FEATURES_REGISTRY.length).toBeGreaterThan(0);
    const ids = NEW_FEATURES_REGISTRY.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is sorted by ascending version (no entry exceeds a later one)", () => {
    for (let i = 1; i < NEW_FEATURES_REGISTRY.length; i++) {
      const prev = toTuple(NEW_FEATURES_REGISTRY[i - 1].version);
      const curr = toTuple(NEW_FEATURES_REGISTRY[i].version);
      // Equal versions are allowed (multiple features per release).
      expect(cmp(prev, curr)).toBeLessThanOrEqual(0);
    }
  });

  it("ends with the maximum version — the last entry is genuinely the latest", () => {
    const lastVersion = toTuple(NEW_FEATURES_REGISTRY[NEW_FEATURES_REGISTRY.length - 1].version);
    for (const f of NEW_FEATURES_REGISTRY) {
      expect(cmp(toTuple(f.version), lastVersion)).toBeLessThanOrEqual(0);
    }
  });

  it("surfaces only features whose MINOR matches the last entry's minor", () => {
    const latestMinor = minorOf(NEW_FEATURES_REGISTRY[NEW_FEATURES_REGISTRY.length - 1].version);
    const surfaced = getUnseenLatestFeatures(NEW_FEATURES_REGISTRY, []);
    expect(surfaced.length).toBeGreaterThan(0);
    expect(surfaced.every((f) => minorOf(f.version) === latestMinor)).toBe(true);
  });
});
