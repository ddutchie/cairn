/**
 * Component tests for StepCreateProject (onboarding "create your first project").
 *
 * Covers the v2.3.2 presentational behavior that unit tests can't reach:
 *  - icon picker selection + aria-pressed state
 *  - submit gating on empty name
 *  - all controls disabled while a create is in flight
 *  - accessible labels on icon-only buttons
 *
 * Runs in the "component" vitest project (jsdom + Testing Library).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepCreateProject } from "./StepCreateProject";

type Props = React.ComponentProps<typeof StepCreateProject>;

function renderStep(overrides: Partial<Props> = {}) {
  const props: Props = {
    name: "",
    icon: "Folder",
    submitting: false,
    onBack: vi.fn(),
    onNameChange: vi.fn(),
    onIconChange: vi.fn(),
    onSubmit: vi.fn((e) => e.preventDefault()),
    onSkip: vi.fn(),
    ...overrides,
  };
  const utils = render(<StepCreateProject {...props} />);
  return { props, ...utils };
}

describe("StepCreateProject", () => {
  it("renders the heading and primary actions", () => {
    renderStep();
    expect(screen.getByRole("heading", { name: /create your first project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Skip/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go back to previous step" })).toBeInTheDocument();
  });

  it("disables submit when the name is empty", () => {
    renderStep({ name: "" });
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
  });

  it("enables submit once a non-empty name is provided", () => {
    renderStep({ name: "My Project" });
    expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled();
  });

  it("treats a whitespace-only name as empty (submit stays disabled)", () => {
    renderStep({ name: "   " });
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
  });

  it("calls onNameChange as the user types", async () => {
    const user = userEvent.setup();
    const { props } = renderStep();
    const input = screen.getByPlaceholderText(/My First Project/i);
    await user.type(input, "Hi");
    expect(props.onNameChange).toHaveBeenCalled();
  });

  it("exposes aria-pressed on the selected icon and aria-labels on each icon button", () => {
    renderStep({ icon: "Rocket" });
    const selected = screen.getByRole("button", { name: "Use Rocket icon" });
    expect(selected).toHaveAttribute("aria-pressed", "true");

    const other = screen.getByRole("button", { name: "Use Folder icon" });
    expect(other).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onIconChange with the picked icon name", async () => {
    const user = userEvent.setup();
    const { props } = renderStep({ icon: "Folder" });
    await user.click(screen.getByRole("button", { name: "Use Rocket icon" }));
    expect(props.onIconChange).toHaveBeenCalledWith("Rocket");
  });

  it("calls onSkip when the skip button is clicked", async () => {
    const user = userEvent.setup();
    const { props } = renderStep();
    await user.click(screen.getByRole("button", { name: /Skip/i }));
    expect(props.onSkip).toHaveBeenCalledTimes(1);
  });

  it("calls onBack when the back button is clicked", async () => {
    const user = userEvent.setup();
    const { props } = renderStep();
    await user.click(screen.getByRole("button", { name: "Go back to previous step" }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  describe("while submitting", () => {
    it("shows the loading label and disables the submit button", () => {
      renderStep({ name: "My Project", submitting: true });
      const submit = screen.getByRole("button", { name: "Creating…" });
      expect(submit).toBeDisabled();
    });

    it("disables back, skip, and every icon button", () => {
      renderStep({ name: "My Project", submitting: true });

      expect(screen.getByRole("button", { name: "Go back to previous step" })).toBeDisabled();
      expect(screen.getByRole("button", { name: /Skip/i })).toBeDisabled();

      // Every icon picker button is disabled.
      for (const btn of screen.getAllByRole("button", { name: /^Use .+ icon$/ })) {
        expect(btn).toBeDisabled();
      }
    });

    it("does not invoke handlers when disabled controls are clicked", async () => {
      const user = userEvent.setup();
      const { props } = renderStep({ name: "My Project", submitting: true });

      await user.click(screen.getByRole("button", { name: "Go back to previous step" }));
      await user.click(screen.getByRole("button", { name: /Skip/i }));
      await user.click(screen.getByRole("button", { name: "Use Rocket icon" }));

      expect(props.onBack).not.toHaveBeenCalled();
      expect(props.onSkip).not.toHaveBeenCalled();
      expect(props.onIconChange).not.toHaveBeenCalled();
    });
  });

  it("limits the name input to 48 characters", () => {
    renderStep();
    const input = screen.getByPlaceholderText(/My First Project/i);
    expect(input).toHaveAttribute("maxLength", "48");
  });

  it("submits the form when a valid name is present", async () => {
    const user = userEvent.setup();
    const { props } = renderStep({ name: "My Project" });
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
});
