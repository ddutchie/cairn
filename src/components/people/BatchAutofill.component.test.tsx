import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCairnStore } from "@/store";

const autofill = vi.fn();
const update = vi.fn();
vi.mock("@/lib/ipc/people", () => ({ peopleClient: { autofill: (...a: unknown[]) => autofill(...a), update: (...a: unknown[]) => update(...a) } }));
import { BatchAutofill } from "./BatchAutofill";

const people = [{ personId: "a", name: "Ana" }, { personId: "b", name: "Ben" }, { personId: "c", name: "Cy" }];
const refresh = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  autofill.mockReset(); update.mockReset().mockResolvedValue({}); refresh.mockClear();
  useCairnStore.setState({ refreshPeople: refresh } as never);
});

describe("BatchAutofill", () => {
  it("reads each note, lists skips, and applies only ticked fields", async () => {
    autofill.mockImplementation(async (id: string) =>
      id === "a" ? { proposals: [{ field: "title", value: "Engineer", quote: "Engineer" }, { field: "team", value: "Sync", quote: "Sync", current: "Old" }] }
      : id === "b" ? { skipped: "private" } : { proposals: [] });
    render(<BatchAutofill people={people} />);
    expect(autofill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Fill details/ }));
    await screen.findByText("Ana");
    expect(autofill).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/Ben \(private to you\)/)).toBeTruthy();
    expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).map((c) => c.checked)).toEqual([true, false]);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("a", { title: "Engineer" }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Saved details for 1 person/)).toBeTruthy();
  });

  it("renders nothing without people", () => {
    const { container } = render(<BatchAutofill people={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
