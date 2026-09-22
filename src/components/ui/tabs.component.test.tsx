import { describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tabs } from "./tabs";

/**
 * Renderer tests for the tab-row primitive — keyboard support is the
 * contract (WAI-APG tabs pattern): roving tabindex, arrows/Home/End move
 * focus AND select, mouse click selects without requiring focus juggling.
 */

const OPTIONS = [
  { value: "chat", label: "Chat" },
  { value: "agents", label: "Coding Agents" },
  { value: "mcp", label: "MCP" },
] as const;

type Value = (typeof OPTIONS)[number]["value"];

function renderTabs(initial: Value = "chat") {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState<Value>(initial);
    return (
      <Tabs
        ariaLabel="Sections"
        value={value}
        onChange={(v) => { onChange(v); setValue(v); }}
        options={OPTIONS.map((o) => ({ ...o }))}
      />
    );
  }
  render(<Harness />);
  return { onChange };
}

describe("Tabs", () => {
  it("marks only the active tab selected and tabbable (roving tabindex)", () => {
    renderTabs("agents");
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("tabindex", "0");
    expect(tabs[0]).toHaveAttribute("tabindex", "-1");
    expect(tabs[2]).toHaveAttribute("tabindex", "-1");
  });

  it("arrow keys move focus and select with wrapping", async () => {
    const user = userEvent.setup();
    const { onChange } = renderTabs("chat");
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("agents");
    expect(screen.getAllByRole("tab")[1]).toHaveFocus();
    // wrap: left from first goes to last
    await user.keyboard("{ArrowLeft}");
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("mcp");
  });

  it("Home/End jump to first/last", async () => {
    const user = userEvent.setup();
    const { onChange } = renderTabs("chat");
    screen.getAllByRole("tab")[0].focus();
    await user.keyboard("{End}");
    expect(onChange).toHaveBeenCalledWith("mcp");
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenCalledWith("chat");
  });

  it("mouse click selects", async () => {
    const user = userEvent.setup();
    const { onChange } = renderTabs("chat");
    await user.click(screen.getByRole("tab", { name: "MCP" }));
    expect(onChange).toHaveBeenCalledWith("mcp");
  });
});
