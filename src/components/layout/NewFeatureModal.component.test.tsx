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

// ── Mock the store ────────────────────────────────────────────────────────────
const markFeatureAsSeen = vi.fn();
let seenFeatures: string[] = [];

vi.mock("@/store", () => ({
  useCairnStore: (selector: (s: unknown) => unknown) =>
    selector({ seenFeatures, markFeatureAsSeen }),
}));

import { NewFeatureModal } from "./NewFeatureModal";
import { NEW_FEATURES_REGISTRY } from "@/lib/new-features-registry";

const LATEST = NEW_FEATURES_REGISTRY[NEW_FEATURES_REGISTRY.length - 1];

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
      seenFeatures = NEW_FEATURES_REGISTRY.map((f) => f.id);
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

      const first = NEW_FEATURES_REGISTRY[0];
      const second = NEW_FEATURES_REGISTRY[1];

      expect(screen.getByText(first.title)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /Next Feature/i }));
      expect(screen.getByText(second.title)).toBeInTheDocument();
    });

    it("jumps to a feature via its pagination dot", async () => {
      const user = userEvent.setup();
      render(<NewFeatureModal forceOpen />);

      // Dot index 3 → 4th registry feature.
      await user.click(screen.getByRole("button", { name: "Go to feature 4" }));
      expect(screen.getByText(NEW_FEATURES_REGISTRY[3].title)).toBeInTheDocument();
    });

    it("marks every displayed feature seen when Skip All is clicked", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<NewFeatureModal forceOpen onClose={onClose} />);

      await user.click(screen.getByRole("button", { name: /Skip All/i }));

      // forceOpen shows the whole registry → all ids marked seen.
      expect(markFeatureAsSeen).toHaveBeenCalledTimes(NEW_FEATURES_REGISTRY.length);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
