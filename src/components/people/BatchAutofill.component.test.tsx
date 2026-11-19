import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCairnStore } from "@/store";

const autofill = vi.fn();
const update = vi.fn();
const get = vi.fn();
vi.mock("@/lib/ipc/people", () => ({ peopleClient: { autofill: (...a: unknown[]) => autofill(...a), update: (...a: unknown[]) => update(...a), get: (...a: unknown[]) => get(...a) } }));
import { BatchAutofill } from "./BatchAutofill";

const people = [{ personId: "a", name: "Ana" }, { personId: "b", name: "Ben" }, { personId: "c", name: "Cy" }];
const refresh = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  autofill.mockReset(); get.mockReset().mockResolvedValue({}); update.mockReset().mockResolvedValue({}); refresh.mockClear();
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

  it("leaves a field alone when it changed since the review", async () => {
    autofill.mockResolvedValue({ proposals: [{ field: "title", value: "Engineer", quote: "Engineer" }] });
    get.mockResolvedValue({ title: "Staff Engineer" });
    render(<BatchAutofill people={[people[0]]} />);
    fireEvent.click(screen.getByRole("button", { name: /Fill details/ }));
    await screen.findByText("Ana");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/changed meanwhile and left alone/)).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("renders nothing without people", () => {
    const { container } = render(<BatchAutofill people={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
