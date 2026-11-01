import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Tooltip, TooltipProvider } from "./tooltip";

describe("Tooltip", () => {
  it("triggers on the button itself when it is enabled", () => {
    render(
      <Tooltip content="Add a provider">
        <button>Add</button>
      </Tooltip>,
      { wrapper: TooltipProvider },
    );
    expect(screen.getByRole("button").parentElement?.tagName).not.toBe("SPAN");
  });

  it("still explains a disabled button, via a wrapper that gets the hover", async () => {
    render(
      <Tooltip content="Finish the open form first" wrapperClassName="flex-1">
        <button disabled>Add</button>
      </Tooltip>,
      { wrapper: TooltipProvider },
    );
    const wrapper = screen.getByRole("button").parentElement!;
    expect(wrapper.tagName).toBe("SPAN");
    expect(wrapper.className).toContain("flex-1");
    act(() => {
      wrapper.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    });
    expect((await screen.findByRole("tooltip")).textContent).toBe("Finish the open form first");
  });
});
