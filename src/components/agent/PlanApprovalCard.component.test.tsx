import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanApprovalCard } from "./PlanApprovalCard";

/**
 * Behaviour suite for the agent plan-approval card (plan-autonomy,
 * plan-request-changes). Named by what the user does, not by implementation.
 *
 * PlanApprovalCard is a pure-props component, so these are deterministic with
 * no Electron/IPC dependency — the autonomy choice and feedback loop are driven
 * entirely through `onApprove` / `onRequestChanges`.
 */

type Props = React.ComponentProps<typeof PlanApprovalCard>;

function renderCard(overrides: Partial<Props> = {}) {
  const props: Props = {
    content: "1. Read the file\n2. Summarise it",
    busy: false,
    onApprove: vi.fn(),
    onRequestChanges: vi.fn(),
    ...overrides,
  };
  render(<PlanApprovalCard {...props} />);
  return props;
}

describe("plan-autonomy", () => {
  it("offers both autonomy choices with the plan visible", () => {
    renderCard();
    expect(screen.getByTestId("plan-approval-card")).toBeTruthy();
    expect(screen.getByTestId("plan-approve-auto")).toBeTruthy();
    expect(screen.getByTestId("plan-approve-interactive")).toBeTruthy();
  });

  it("approves in auto mode (autoApprove=true) via 'Approve & run'", async () => {
    const user = userEvent.setup();
    const props = renderCard();
    await user.click(screen.getByTestId("plan-approve-auto"));
    expect(props.onApprove).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("approves in interactive mode (autoApprove=false) via 'Ask per step'", async () => {
    const user = userEvent.setup();
    const props = renderCard();
    await user.click(screen.getByTestId("plan-approve-interactive"));
    expect(props.onApprove).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("disables every action while a decision is in flight (busy)", () => {
    renderCard({ busy: true });
    expect(screen.getByTestId<HTMLButtonElement>("plan-approve-auto").disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>("plan-approve-interactive").disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>("plan-request-changes").disabled).toBe(true);
  });
});

describe("plan-request-changes", () => {
  it("reveals a feedback box and sends the typed feedback", async () => {
    const user = userEvent.setup();
    const props = renderCard();

    // No feedback box until the user asks to change the plan.
    expect(screen.queryByTestId("plan-feedback")).toBeNull();
    await user.click(screen.getByTestId("plan-request-changes"));

    const box = screen.getByTestId("plan-feedback");
    await user.type(box, "Add error handling");
    await user.click(screen.getByTestId("plan-submit-feedback"));

    expect(props.onRequestChanges).toHaveBeenCalledExactlyOnceWith("Add error handling");
    // Approving is not triggered by requesting changes.
    expect(props.onApprove).not.toHaveBeenCalled();
  });

  it("will not submit empty or whitespace-only feedback", async () => {
    const user = userEvent.setup();
    const props = renderCard();
    await user.click(screen.getByTestId("plan-request-changes"));

    // Submit stays disabled with no input…
    expect(screen.getByTestId<HTMLButtonElement>("plan-submit-feedback").disabled).toBe(true);
    // …and after only whitespace.
    await user.type(screen.getByTestId("plan-feedback"), "   ");
    expect(screen.getByTestId<HTMLButtonElement>("plan-submit-feedback").disabled).toBe(true);
    expect(props.onRequestChanges).not.toHaveBeenCalled();
  });

  it("returns to the action row when the feedback is cancelled", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByTestId("plan-request-changes"));
    expect(screen.getByTestId("plan-feedback")).toBeTruthy();

    await user.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("plan-feedback")).toBeNull();
    expect(screen.getByTestId("plan-approve-auto")).toBeTruthy();
  });
});
