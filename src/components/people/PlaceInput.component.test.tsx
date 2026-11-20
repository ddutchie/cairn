import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "../../../shared/people/place-data";
import { PlaceInput } from "./PlaceInput";

const type = (text: string) => fireEvent.change(screen.getByRole("combobox"), { target: { value: text } });

describe("PlaceInput", () => {
  it("suggests cities as you type and saves the picked one with its zone", () => {
    const onCommit = vi.fn();
    render(<PlaceInput mode="location" ariaLabel="Location" value="" onCommit={onCommit} />);
    fireEvent.focus(screen.getByRole("combobox"));
    type("san fr");
    const option = screen.getByRole("option", { name: /San Francisco, California, US/ });
    fireEvent.mouseDown(option);
    expect(onCommit).toHaveBeenCalledWith("San Francisco, California, US", "America/Los_Angeles");
  });

  it("picks with the keyboard, and Escape closes the list without saving", () => {
    const onCommit = vi.fn();
    render(<PlaceInput mode="location" ariaLabel="Location" value="" onCommit={onCommit} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    type("montr");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
    type("montre");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(expect.stringMatching(/^Montr/), "America/Toronto");
  });

  it("suggests zone names for a time zone, including from a city", () => {
    const onCommit = vi.fn();
    render(<PlaceInput mode="timezone" ariaLabel="Time zone" value="" onCommit={onCommit} />);
    fireEvent.focus(screen.getByRole("combobox"));
    type("san fr");
    fireEvent.mouseDown(screen.getByRole("option", { name: /America\/Los_Angeles/ }));
    expect(onCommit).toHaveBeenCalledWith("America/Los_Angeles", undefined);
  });

  it("still saves free text on blur", () => {
    const onCommit = vi.fn();
    render(<PlaceInput mode="location" ariaLabel="Location" value="" onCommit={onCommit} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    type("Narnia");
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("Narnia");
  });
});
