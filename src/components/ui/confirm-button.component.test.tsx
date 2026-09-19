import { describe, expect, it, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmButton, useConfirmAction } from "./confirm-button";

/**
 * Renderer tests for the two-step confirm primitive:
 * first click arms (danger label, focus moved, announced), second fires;
 * Escape or timeout disarms without firing.
 */

function renderArmed() {
  const onConfirm = vi.fn();
  render(
    <ConfirmButton confirmLabel="Confirm delete?" onConfirm={onConfirm} showCancel>
      Delete
    </ConfirmButton>
  );
  return { onConfirm };
}

describe("ConfirmButton", () => {
  it("arms on first click and fires on second", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderArmed();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    // Armed: danger confirm visible, focus moved to it, announced.
    const confirm = screen.getByRole("button", { name: "Confirm delete?" });
    expect(confirm).toBeInTheDocument();
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Escape disarms without firing", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderArmed();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("button", { name: "Confirm delete?" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Cancel disarms without firing", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderArmed();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("auto-disarms after the timeout without firing", async () => {
    vi.useFakeTimers();
    try {
      const onConfirm = vi.fn();
      render(
        <ConfirmButton confirmLabel="Confirm delete?" onConfirm={onConfirm}>
          Delete
        </ConfirmButton>
      );
      // fireEvent (not user.click): user-event's internal delays deadlock
      // under fake timers before we get a chance to advance them.
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(screen.getByRole("button", { name: "Confirm delete?" })).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(4100); });
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("useConfirmAction cleans up its timer on unmount", async () => {
    vi.useFakeTimers();
    try {
      function Probe() {
        const { armed, arm } = useConfirmAction(1000);
        return <button onClick={arm}>{armed ? "armed" : "idle"}</button>;
      }
      const { unmount } = render(<Probe />);
      fireEvent.click(screen.getByRole("button", { name: "idle" }));
      expect(screen.getByRole("button", { name: "armed" })).toBeInTheDocument();
      unmount();
      // Must not throw or warn when the timer fires post-unmount.
      await act(async () => { vi.advanceTimersByTime(2000); });
    } finally {
      vi.useRealTimers();
    }
  });
});
