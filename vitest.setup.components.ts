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

afterEach(() => {
  cleanup();
});
