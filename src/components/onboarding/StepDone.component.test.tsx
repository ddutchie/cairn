/**
 * Component test for StepDone — the final onboarding slide ("Open Cairn").
 *
 * Guards the UI half of the onboarding-completion chain: clicking "Open Cairn"
 * must invoke onComplete with the demo switch state. page.tsx wires that
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
  it("calls onComplete(true) when the demo switch is left on (default)", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<StepDone onBack={vi.fn()} onComplete={onComplete} hasProject />);

    await user.click(screen.getByRole("button", { name: /Open Cairn/i }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(true);
  });

  it("calls onComplete(false) when the demo switch is turned off", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<StepDone onBack={vi.fn()} onComplete={onComplete} hasProject />);

    await user.click(screen.getByRole("switch", { name: "Start the demo" }));
    await user.click(screen.getByRole("button", { name: /Open Cairn/i }));

    expect(onComplete).toHaveBeenCalledWith(false);
  });

  it("disables the demo switch and starts without a demo when there is no project", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<StepDone onBack={vi.fn()} onComplete={onComplete} hasProject={false} />);

    expect(screen.getByRole("switch", { name: "Start the demo" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Open Cairn/i }));

    expect(onComplete).toHaveBeenCalledWith(false);
  });

});
