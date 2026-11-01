import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsRow, StepperSettingsRow } from "./form-row";
import { Button } from "./button";

/**
 * The row label names a form control, but never replaces a button's own text
 * as its accessible name.
 */
describe("SettingsRow labelling", () => {
  it("labels a form control with the row label", () => {
    render(<SettingsRow label="Workspace name"><input defaultValue="Cairn HQ" /></SettingsRow>);
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toBeInTheDocument();
  });

  it("leaves a native button named by its own text", () => {
    render(<SettingsRow label="Community providers"><button type="button">Browse Community</button></SettingsRow>);
    expect(screen.getByRole("button", { name: "Browse Community" })).toBeInTheDocument();
  });

  it("leaves a Button named by its own text", () => {
    render(<SettingsRow label="Export data"><Button>Export</Button></SettingsRow>);
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
  });
});

describe("StepperSettingsRow", () => {
  function setup(value: number, extra: Partial<React.ComponentProps<typeof StepperSettingsRow>> = {}) {
    const onChange = vi.fn();
    render(<StepperSettingsRow label="Max steps" value={value} onChange={onChange} presets={[10, 30]} min={1} max={100} {...extra} />);
    return { onChange, user: userEvent.setup() };
  }

  it("is one group with the presets and a custom field", () => {
    setup(30);
    const group = screen.getByRole("group", { name: "Max steps" });
    expect(group).toContainElement(screen.getByRole("button", { name: "10" }));
    expect(screen.getByRole("button", { name: "30" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("spinbutton", { name: "Max steps, custom value" })).toBeInTheDocument();
  });

  it("picks a preset", async () => {
    const { user, onChange } = setup(30);
    await user.click(screen.getByRole("button", { name: "10" }));
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it("commits a custom value on blur, clamped to the range", async () => {
    const { user, onChange } = setup(30);
    const input = screen.getByRole("spinbutton", { name: "Max steps, custom value" });
    await user.clear(input);
    await user.type(input, "500");
    await user.tab();
    expect(onChange).toHaveBeenCalledWith(100);
  });

  it("leaves the custom field empty for a preset, and tabbing through changes nothing", async () => {
    const { user, onChange } = setup(30, { onAuto: () => {}, autoActive: false });
    const input = screen.getByRole("spinbutton", { name: "Max steps, custom value" });
    expect(input).toHaveValue(null);
    await user.click(input);
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows a custom value in the field", () => {
    setup(42);
    expect(screen.getByRole("spinbutton", { name: "Max steps, custom value" })).toHaveValue(42);
  });

  it("shows Auto as the active choice and empties the field when Auto means no value", () => {
    setup(30, { onAuto: () => {}, autoActive: true, autoSuppressesValue: true });
    expect(screen.getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "30" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("spinbutton", { name: "Max steps, custom value" })).toHaveValue(null);
  });
});
