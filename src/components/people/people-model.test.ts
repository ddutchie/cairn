import { describe, it, expect } from "vitest";
import { describeRelation, foldText, groupKeysFor, groupPeople, splitList } from "./people-model";
import type { PersonRelationView, PersonSummary } from "../../../shared/types/people-view";

const p = (name: string, types: PersonSummary["relationship"][number]["type"][]): PersonSummary => ({
  id: name, workspaceId: "ws", name, aliases: [], emails: [],
  relationship: types.map((type) => ({ type, provenance: "explicit" })),
  status: "confirmed", provenance: "explicit", isMe: false, agentPrivate: false, createdAt: "", updatedAt: "",
});

const rel = (role: PersonRelationView["role"], otherName: string, edge: Partial<PersonRelationView["edge"]> = {}) =>
  ({ role, otherName, edge: { id: "e", label: undefined, endedAt: undefined, ...edge } }) as PersonRelationView;

describe("people-model", () => {
  it("puts unknown or empty relationship sets under Other", () => {
    expect(groupKeysFor([])).toEqual(["other"]);
    expect(groupKeysFor([{ type: "recruiter", provenance: "explicit" }])).toEqual(["other"]);
  });

  it("narrows to one group and sorts names", () => {
    const groups = groupPeople([p("Zed", ["peer"]), p("amy", ["peer"]), p("Bo", ["manager"])], { only: "peer" });
    expect(groups.map((g) => [g.key, g.people.map((x) => x.name)])).toEqual([["peer", ["amy", "Zed"]]]);
  });

  it("reads edges from the person's side, marking former ones", () => {
    expect(describeRelation(rel("reports_to", "Elisa"))).toBe("Reports to Elisa");
    expect(describeRelation(rel("mentee_of", "Sebastien", { endedAt: "2026-01-01" }))).toBe("Mentor: Sebastien (former)");
    expect(describeRelation(rel("partner", "Chris", { label: "AA-in-MC trifecta" }))).toBe("Works with Chris, AA-in-MC trifecta");
  });

  it("folds accents and splits lists", () => {
    expect(foldText("Sébastien")).toBe("sebastien");
    expect(splitList(" a@x.io, b@x.io ,,\nc ")).toEqual(["a@x.io", "b@x.io", "c"]);
  });
});
