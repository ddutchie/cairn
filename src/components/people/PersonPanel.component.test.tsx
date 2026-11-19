import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useCairnStore } from "@/store";

const pageOf = vi.fn();
vi.mock("@/lib/ipc/people", () => ({ peopleClient: { page: (...a: unknown[]) => pageOf(...a) } }));
vi.mock("./PersonPage", () => ({ PersonPage: ({ page }: { page: { person: { name: string } } | null }) => <div>{page ? `page:${page.person.name}` : "loading"}</div> }));
import { PersonPanel } from "./PersonPanel";

const page = (name: string) => ({ person: { id: name, name } });
beforeEach(() => {
  pageOf.mockReset().mockImplementation(async (id: string) => (id === "gone" ? null : page(id)));
  useCairnStore.setState({ peopleLoaded: true, people: [], selectedPersonId: "keep", loadPeople: vi.fn() } as never);
});

describe("PersonPanel", () => {
  it("settles on not found for a deleted person without requesting again", async () => {
    render(<PersonPanel personId="gone" />);
    expect(await screen.findByText("Person not found")).toBeTruthy();
    expect(pageOf).toHaveBeenCalledTimes(1);
  });

  it("two panels show different people, and one missing person doesn't blank the other", async () => {
    render(<><PersonPanel personId="gone" /><PersonPanel personId="Ben" /></>);
    expect(await screen.findByText("Person not found")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("page:Ben")).toBeTruthy());
  });

  it("leaves the People view's selection alone", async () => {
    render(<PersonPanel personId="Ben" />);
    await screen.findByText("page:Ben");
    expect(useCairnStore.getState().selectedPersonId).toBe("keep");
  });
});
