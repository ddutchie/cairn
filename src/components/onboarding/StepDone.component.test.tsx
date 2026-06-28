/**
 * Component test for StepDone — the final onboarding slide ("Open Cairn").
 *
 * Guards the UI half of the onboarding-completion chain: clicking "Open Cairn"
 * must invoke onComplete with the tour-checkbox state. page.tsx wires that
 * onComplete to completeOnboarding(), whose hydrate-before-exit ordering is
 * unit-tested in src/lib/complete-onboarding.test.ts.
 *
 * Runs in the "component" vitest project (jsdom + Testing Library).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepDone } from "./StepDone";

describe("StepDone", () => {
  it("calls onComplete(true) when the tour checkbox is left checked (default)", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<StepDone onBack={vi.fn()} onComplete={onComplete} />);

    await user.click(screen.getByRole("button", { name: /Open Cairn/i }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(true);
  });

  it("calls onComplete(false) when the tour checkbox is unchecked", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<StepDone onBack={vi.fn()} onComplete={onComplete} />);

    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /Open Cairn/i }));

    expect(onComplete).toHaveBeenCalledWith(false);
  });
});
