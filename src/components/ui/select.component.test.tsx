import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select } from "./select";

/**
 * The trigger's accessible name keeps the current value ("Label mode: Smart")
 * and the open menu says which option is selected.
 */
describe("Select", () => {
  const options = [
    { value: "smart", label: "Smart" },
    { value: "all", label: "All" },
  ];

  it("names the trigger with its label and current value", () => {
    render(<Select ariaLabel="Label mode" value="smart" options={options} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /^Label mode:\s?Smart$/ })).toBeInTheDocument();
  });

  it("marks the selected option as checked and picks another", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Select ariaLabel="Label mode" value="smart" options={options} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /^Label mode:\s?Smart$/ }));
    expect(screen.getByRole("menuitemradio", { name: "Smart" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "All" })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("menuitemradio", { name: "All" }));
    expect(onChange).toHaveBeenCalledWith("all");
  });
});
