/**
 * Vitest setup for the "component" project (jsdom + Testing Library).
 *
 * - Registers @testing-library/jest-dom matchers (toBeInTheDocument, toBeDisabled,
 *   toHaveAttribute, etc.).
 * - Auto-cleans the rendered DOM after every test to isolate cases.
 */

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no ResizeObserver, but components (e.g. the callout widget, which
// re-measures on height changes) reference it. A no-op stub lets them mount;
// tests that need to assert re-measurement can spy on requestMeasure instead.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
});
