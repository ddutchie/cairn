/**
 * Settings → Sidebar & views: the People switch only exists while the People
 * layer flag is on, and starts off (the view is hidden on first run).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useCairnStore } from "@/store";
import { FIRST_RUN_HIDDEN_VIEWS, type ToggleableView } from "@/store/slices/ui";
import { ViewVisibilitySettings } from "./ViewVisibilitySettings";

beforeEach(() => {
  useCairnStore.setState({ hiddenViews: new Set<ToggleableView>(FIRST_RUN_HIDDEN_VIEWS), peopleEnabled: false });
});

describe("ViewVisibilitySettings: People", () => {
  it("has no People switch while the flag is off", () => {
    render(<ViewVisibilitySettings />);
    expect(screen.queryByRole("switch", { name: "Toggle People" })).toBeNull();
  });

  it("shows the People switch, off by default, once the flag is on", () => {
    useCairnStore.setState({ peopleEnabled: true });
    render(<ViewVisibilitySettings />);
    const sw = screen.getByRole("switch", { name: "Toggle People" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(useCairnStore.getState().hiddenViews.has("people")).toBe(false);
    expect(screen.getByRole("switch", { name: "Toggle People" })).toHaveAttribute("aria-checked", "true");
  });
});
