import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Combobox, type ComboboxOption } from "./combobox";

/**
 * Renderer tests for the searchable picker: opens on the trigger, filters as
 * you type, moves with the arrow keys without leaving the field, picks with
 * Enter, and clears the query before closing on Escape.
 */

const OPTIONS: ComboboxOption<string>[] = [
  { value: "a", label: "Summarize this project", group: "Cairn" },
  { value: "b", label: "Release checklist", group: "Cairn" },
  { value: "c", label: "QR pairing", group: "Mobile", keywords: "auth" },
  { value: "d e/f", label: "Odd value", group: "Mobile" },
];

function setup(value: string | null = "a") {
  const onChange = vi.fn();
  render(<Combobox ariaLabel="Sessions" value={value} options={OPTIONS} onChange={onChange} />);
  return { onChange, user: userEvent.setup() };
}

describe("Combobox", () => {
  it("shows the selected label and lists grouped options when opened", async () => {
    const { user } = setup();
    const trigger = screen.getByRole("button", { name: "Sessions" });
    expect(trigger).toHaveTextContent("Summarize this project");
    await user.click(trigger);
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getByRole("group", { name: "Mobile" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Summarize/ })).toHaveAttribute("aria-selected", "true");
  });

  it("filters by label and hidden keywords", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    await user.type(screen.getByRole("combobox"), "auth");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("QR pairing");
  });

  it("moves with arrow keys and picks with Enter", async () => {
    const { user, onChange } = setup();
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("clears the query on the first Escape and keeps the list open", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    const input = screen.getByRole("combobox");
    await user.type(input, "zzz");
    expect(screen.getByText("No matches")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    expect(screen.getAllByRole("option")).toHaveLength(4);
  });

  it("keeps aria-activedescendant a single valid id for values with spaces", async () => {
    const { user } = setup("d e/f");
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    const id = screen.getByRole("combobox").getAttribute("aria-activedescendant") ?? "";
    expect(id).not.toMatch(/\s/);
    expect(document.getElementById(id)).toHaveTextContent("Odd value");
  });
});
