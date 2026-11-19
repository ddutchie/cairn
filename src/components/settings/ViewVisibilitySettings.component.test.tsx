/**
 * Settings → Sidebar & views: People is an ordinary view with a switch, on by default.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useCairnStore } from "@/store";
import { FIRST_RUN_HIDDEN_VIEWS, type ToggleableView } from "@/store/slices/ui";
import { ViewVisibilitySettings } from "./ViewVisibilitySettings";

beforeEach(() => {
  useCairnStore.setState({ hiddenViews: new Set<ToggleableView>(FIRST_RUN_HIDDEN_VIEWS) });
});

describe("ViewVisibilitySettings: People", () => {
  it("lists People, on by default, and hides it when switched off", () => {
    render(<ViewVisibilitySettings />);
    const sw = screen.getByRole("switch", { name: "Toggle People" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    expect(useCairnStore.getState().hiddenViews.has("people")).toBe(true);
    expect(screen.getByRole("switch", { name: "Toggle People" })).toHaveAttribute("aria-checked", "false");
  });
});
