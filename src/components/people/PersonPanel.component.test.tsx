import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useCairnStore } from "@/store";
import { PersonPanel } from "./PersonPanel";

const selectPerson = vi.fn();
beforeEach(() => {
  selectPerson.mockReset();
  // A deleted person: selecting clears the selection again, as the store does on a not-found page.
  useCairnStore.setState({ selectedPersonId: null, personPage: null, peopleLoaded: true, selectPerson, loadPeople: vi.fn(), refreshPeople: vi.fn() } as never);
});

describe("PersonPanel", () => {
  it("selects a requested person once and settles on a not-found state", () => {
    const { rerender } = render(<PersonPanel personId="gone" />);
    rerender(<PersonPanel personId="gone" />);
    rerender(<PersonPanel personId="gone" />);
    expect(selectPerson).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Person not found")).toBeTruthy();
  });
});
