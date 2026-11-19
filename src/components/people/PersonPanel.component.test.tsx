import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useCairnStore } from "@/store";
import { emitChangeFeed } from "@/store/change-feed";

const pageOf = vi.fn();
vi.mock("@/lib/ipc/people", () => ({ peopleClient: { page: (...a: unknown[]) => pageOf(...a) } }));
vi.mock("./PersonPage", () => ({ PersonPage: ({ page }: { page: { person: { name: string } } | null }) => <div>{page ? `page:${page.person.name}` : "loading"}</div> }));
import { PersonPanel } from "./PersonPanel";

const page = (name: string) => ({ person: { id: name, name } });
const loadPeople = vi.fn();
beforeEach(() => {
  pageOf.mockReset().mockImplementation(async (id: string) => (id === "gone" ? null : page(id)));
  // The real loadPeople replaces the list; mirror that so the panel's reread cue fires.
  loadPeople.mockReset().mockImplementation(async () => { useCairnStore.setState({ people: [] as never }); });
  useCairnStore.setState({ peopleLoaded: true, people: [], selectedPersonId: "keep", loadPeople } as never);
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

  it("switches between a found and a missing person", async () => {
    const { rerender } = render(<PersonPanel personId="Ben" />);
    await screen.findByText("page:Ben");
    rerender(<PersonPanel personId="gone" />);
    expect(await screen.findByText("Person not found")).toBeTruthy();
    rerender(<PersonPanel personId="Ben" />);
    expect(await screen.findByText("page:Ben")).toBeTruthy();
  });

  it("rereads when the list changes and when the change feed fires (which reloads the list)", async () => {
    render(<PersonPanel personId="Ben" />);
    await screen.findByText("page:Ben");
    expect(pageOf).toHaveBeenCalledTimes(1);
    await act(async () => { useCairnStore.setState({ people: [] as never }); });
    await waitFor(() => expect(pageOf).toHaveBeenCalledTimes(2));
    await act(async () => { emitChangeFeed({} as never); });
    expect(loadPeople).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(pageOf).toHaveBeenCalledTimes(3));
  });

  it("reads once when the list loads after mount", async () => {
    useCairnStore.setState({ peopleLoaded: false } as never);
    render(<PersonPanel personId="Ben" />);
    await screen.findByText("page:Ben");
    expect(pageOf).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest read when an older one resolves last", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    pageOf.mockImplementation(() => new Promise((res) => { resolvers.push(res); }));
    render(<PersonPanel personId="Ben" />);
    await act(async () => { useCairnStore.setState({ people: [] as never }); });
    // Nothing has landed yet, so the list change must not have started a second read.
    expect(resolvers).toHaveLength(1);
    await act(async () => { resolvers[0](page("Ben")); });
    pageOf.mockImplementation(() => new Promise((res) => { resolvers.push(res); }));
    await act(async () => { useCairnStore.setState({ people: [] as never }); });
    await act(async () => { useCairnStore.setState({ people: [] as never }); });
    expect(resolvers).toHaveLength(3);
    await act(async () => { resolvers[2]({ person: { id: "Ben", name: "Ben new" } }); });
    await act(async () => { resolvers[1](page("Ben old")); });
    expect(screen.getByText("page:Ben new")).toBeTruthy();
  });
});
