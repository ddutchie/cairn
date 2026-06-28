/**
 * Component tests for NewFeatureModal — the "What's New" highlights modal.
 *
 * Demonstrates the component harness with a store-connected component: the
 * @/store module is mocked so seenFeatures and markFeatureAsSeen are fully
 * controllable. Radix Dialog content is portaled to document.body; Testing
 * Library queries it from there.
 *
 * Runs in the "component" vitest project (jsdom + Testing Library).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NewFeature } from "@/lib/new-features-registry";

// ── Mock the store ────────────────────────────────────────────────────────────
const markFeatureAsSeen = vi.fn();
let seenFeatures: string[] = [];

vi.mock("@/store", () => ({
  useCairnStore: (selector: (s: unknown) => unknown) =>
    selector({ seenFeatures, markFeatureAsSeen }),
}));

// ── Mock the registry ─────────────────────────────────────────────────────────
// Decouple the modal-behavior assertions from the live registry: a stable local
// fixture means these tests don't break when real release notes are added/changed.
// Two versions, with the latest (v9.1) holding a single feature so the boot gate
// surfaces exactly one item — mirroring the real single-latest-feature contract.
// Built via vi.hoisted so it's available to the hoisted vi.mock factory below.
const { FIXTURE_REGISTRY } = vi.hoisted(() => {
  const FEATURE = (id: string, version: string, title: string): NewFeature => ({
    id,
    version,
    title,
    category: "Test",
    description: `${title} description`,
    highlights: [`${title} highlight`],
  });
  return {
    FIXTURE_REGISTRY: [
      FEATURE("v9.0-alpha", "v9.0", "Alpha Feature"),
      FEATURE("v9.0-beta", "v9.0", "Beta Feature"),
      FEATURE("v9.0-gamma", "v9.0", "Gamma Feature"),
      FEATURE("v9.0-delta", "v9.0", "Delta Feature"),
      FEATURE("v9.1-latest", "v9.1", "Latest Feature"),
    ] as NewFeature[],
  };
});

vi.mock("@/lib/new-features-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/new-features-registry")>();
  return { ...actual, NEW_FEATURES_REGISTRY: FIXTURE_REGISTRY };
});

import { NewFeatureModal } from "./NewFeatureModal";

const LATEST = FIXTURE_REGISTRY[FIXTURE_REGISTRY.length - 1];

beforeEach(() => {
  markFeatureAsSeen.mockClear();
  seenFeatures = [];
});

describe("NewFeatureModal", () => {
  it("renders the latest unseen feature on mount", () => {
    render(<NewFeatureModal />);
    expect(screen.getByRole("heading", { name: /What's New in Cairn/i })).toBeInTheDocument();
    expect(screen.getByText(LATEST.title)).toBeInTheDocument();
  });

  it("does not render when the latest feature is already seen", () => {
    seenFeatures = [LATEST.id];
    render(<NewFeatureModal />);
    expect(screen.queryByRole("heading", { name: /What's New in Cairn/i })).not.toBeInTheDocument();
  });

  it("shows a single-feature footer with a 'Done' action (no pagination)", () => {
    render(<NewFeatureModal />);
    // The latest registry version has exactly one feature → Done, no dots/Skip All.
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Skip All/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Go to feature/i })).not.toBeInTheDocument();
  });

  it("marks the displayed feature seen and calls onClose when Done is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NewFeatureModal onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(markFeatureAsSeen).toHaveBeenCalledWith(LATEST.id);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("forceOpen (Settings entrypoint)", () => {
    it("renders even when everything has been seen", () => {
      seenFeatures = FIXTURE_REGISTRY.map((f) => f.id);
      render(<NewFeatureModal forceOpen />);
      expect(screen.getByRole("heading", { name: /What's New in Cairn/i })).toBeInTheDocument();
    });

    it("shows pagination + Skip All when the full registry has multiple features", () => {
      render(<NewFeatureModal forceOpen />);
      // The full registry has many features → dots, Skip All, and Next.
      expect(screen.getByRole("button", { name: "Go to feature 1" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Skip All/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Next Feature/i })).toBeInTheDocument();
    });

    it("advances to the next feature and disables Prev only on the first slide", async () => {
      const user = userEvent.setup();
      render(<NewFeatureModal forceOpen />);

      const first = FIXTURE_REGISTRY[0];
      const second = FIXTURE_REGISTRY[1];

      // First slide: showing feature[0], Prev is disabled.
      expect(screen.getByText(first.title)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Previous feature" })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: /Next Feature/i }));

      // Second slide: showing feature[1], Prev is now enabled.
      expect(screen.getByText(second.title)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Previous feature" })).toBeEnabled();
    });

    it("jumps to a feature via its pagination dot", async () => {
      const user = userEvent.setup();
      render(<NewFeatureModal forceOpen />);

      // Dot index 3 → 4th registry feature.
      await user.click(screen.getByRole("button", { name: "Go to feature 4" }));
      expect(screen.getByText(FIXTURE_REGISTRY[3].title)).toBeInTheDocument();
    });

    it("marks every displayed feature seen when Skip All is clicked", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<NewFeatureModal forceOpen onClose={onClose} />);

      await user.click(screen.getByRole("button", { name: /Skip All/i }));

      // forceOpen shows the whole registry → all ids marked seen.
      expect(markFeatureAsSeen).toHaveBeenCalledTimes(FIXTURE_REGISTRY.length);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
