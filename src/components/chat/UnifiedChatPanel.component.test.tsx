/**
 * The pixel chat theme is one attribute on the panel: set while The Workspace
 * is open, absent otherwise. The look itself is CSS (`[data-pixel]`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useCairnStore } from "@/store";
import { UnifiedChatPanel } from "./UnifiedChatPanel";

vi.mock("@/components/agent/SessionPane", () => ({ SessionPane: () => null }));
vi.mock("./PreviewPane", () => ({ PreviewPane: () => null }));

afterEach(() => act(() => useCairnStore.getState().setOfficeOpen(false)));

describe("UnifiedChatPanel pixel theme", () => {
  it("carries data-pixel only while the office is open", () => {
    const { container } = render(<UnifiedChatPanel />);
    const panel = container.querySelector("aside")!;
    expect(panel).not.toHaveAttribute("data-pixel");
    act(() => useCairnStore.getState().setOfficeOpen(true));
    expect(panel).toHaveAttribute("data-pixel", "office");
    act(() => useCairnStore.getState().setOfficeOpen(false));
    expect(panel).not.toHaveAttribute("data-pixel");
  });
});
