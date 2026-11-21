import { describe, it, expect, beforeEach } from "vitest";
import { useCairnStore } from "@/store";
import type { Team, TeamLink } from "../../../shared/types/people";

const link = (n: string): TeamLink => ({ label: n, url: `https://x.test/${n}` });

describe("editTeamLinks", () => {
  let saved: TeamLink[];
  beforeEach(() => {
    saved = [];
    // The store never refreshes here (as when the refetch after a save fails): the list in it stays old.
    useCairnStore.setState({
      teams: [{ id: "t1", links: [] } as unknown as Team],
      updateTeam: async (_id, patch) => {
        await new Promise((r) => setTimeout(r, 5));
        saved = patch.links ?? [];
        return { id: "t1", links: saved } as unknown as Team;
      },
    });
  });

  it("builds each edit on what the one before saved, in order", async () => {
    const { editTeamLinks } = useCairnStore.getState();
    await Promise.all([
      editTeamLinks("t1", (l) => [...l, link("a")]),
      editTeamLinks("t1", (l) => [...l, link("b")]),
    ]);
    expect(saved.map((l) => l.label)).toEqual(["a", "b"]);
  });

  it("uses the store again once the queue is idle", async () => {
    const { editTeamLinks } = useCairnStore.getState();
    await editTeamLinks("t1", (l) => [...l, link("a")]);
    await new Promise((r) => setTimeout(r, 0));
    useCairnStore.setState({ teams: [{ id: "t1", links: [link("z")] } as unknown as Team] });
    await editTeamLinks("t1", (l) => [...l, link("b")]);
    expect(saved.map((l) => l.label)).toEqual(["z", "b"]);
  });
});
