import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCairnStore } from "@/store";
import { localDate } from "../../../shared/today/brief";

const mark = vi.hoisted(() => vi.fn(() => Promise.resolve({ done: [], edits: {} })));
vi.mock("@/lib/ipc/automations", () => ({ todayClient: { mark }, automationsClient: {} }));

import { TodayNudges } from "./today-nudges";

const nudges = [
  { id: "nudge-p1", personId: "p1", name: "Ana Ruiz", title: "No 1:1 with Ana Ruiz in 3 weeks", days: 22 },
  { id: "nudge-p2", personId: "p2", name: "Ben", title: "No 1:1 with Ben in 12 days", days: 12 },
];
const view = () => render(<TodayNudges nudges={nudges} workspaceId="ws1" />, { wrapper: TooltipProvider });

beforeEach(() => { vi.clearAllMocks(); });

describe("TodayNudges", () => {
  it("lists each nudge", () => {
    view();
    expect(screen.getByText("No 1:1 with Ana Ruiz in 3 weeks")).toBeTruthy();
    expect(screen.getByText("No 1:1 with Ben in 12 days")).toBeTruthy();
  });
  it("renders nothing without nudges", () => {
    const { container } = render(<TodayNudges nudges={[]} workspaceId="ws1" />);
    expect(container.textContent).toBe("");
  });
  it("hides one for the day when it's marked done", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Done: No 1:1 with Ana Ruiz in 3 weeks" }));
    expect(screen.queryByText("No 1:1 with Ana Ruiz in 3 weeks")).toBeNull();
    expect(screen.getByText("No 1:1 with Ben in 12 days")).toBeTruthy();
    await waitFor(() => expect(mark).toHaveBeenCalledWith("ws1", localDate(new Date()), { done: { "nudge-p1": true } }));
  });
  it("opens the person's page", () => {
    const setView = vi.fn();
    const selectPerson = vi.fn();
    useCairnStore.setState({ setView, selectPerson } as never);
    view();
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[1]);
    expect(setView).toHaveBeenCalledWith("people");
    expect(selectPerson).toHaveBeenCalledWith("p2");
  });
});
