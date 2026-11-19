import { describe, it, expect } from "vitest";
import { ownedItemsIn, setItemDone } from "./action-items";
import { foldName } from "./parse";
import type { Candidate } from "./resolve";

const person = (id: string, name: string): Candidate => ({ id, status: "confirmed", slackId: null, emails: [], keys: new Set([foldName(name)]) });
const people = [person("ana", "Ana Ruiz"), person("ben1", "Ben Lee"), person("ben2", "Ben Lee")];

describe("ownedItemsIn", () => {
  it("lists only owned lines, resolving a name to one person (never a stub, never a guess)", () => {
    const body = "- [ ] **Ana Ruiz** - send the deck\n- [x] [[Ana Ruiz]]: done already\n- [ ] **Ben Lee** - two of them\n- [ ] no owner here\n- [ ] **Team** - plan\n";
    const items = ownedItemsIn(body, people);
    expect(items.map((i) => [i.ownerText, i.ownerPersonId, i.done])).toEqual([
      ["Ana Ruiz", "ana", false], ["Ana Ruiz", "ana", true], ["Ben Lee", null, false], ["Team", null, false],
    ]);
  });

  it("keeps a stable key when a box is ticked, and suffixes identical lines", () => {
    const open = ownedItemsIn("- [ ] **Ana Ruiz** - same\n- [ ] **Ana Ruiz** - same\n", people);
    const ticked = ownedItemsIn("- [x] **Ana Ruiz** - same\n- [ ] **Ana Ruiz** - same\n", people);
    expect(open[0].lineKey).toBe(ticked[0].lineKey);
    expect(open[1].lineKey).toBe(`${open[0].lineKey}#2`);
  });
});

describe("setItemDone", () => {
  const body = "# Notes\n\n- [ ] **Ana Ruiz** - send the deck\n- [ ] **Ana Ruiz** - send the deck\n- [ ] other\n";
  const [first, second] = ownedItemsIn(body, people);

  it("changes only the one box", () => {
    expect(setItemDone(body, second.lineKey, true)).toBe("# Notes\n\n- [ ] **Ana Ruiz** - send the deck\n- [x] **Ana Ruiz** - send the deck\n- [ ] other\n");
    expect(setItemDone(body, first.lineKey, true)).toBe("# Notes\n\n- [x] **Ana Ruiz** - send the deck\n- [ ] **Ana Ruiz** - send the deck\n- [ ] other\n");
  });

  it("unticks, and is a no-op when the box is already in that state", () => {
    const ticked = setItemDone(body, first.lineKey, true)!;
    expect(setItemDone(ticked, first.lineKey, false)).toBe(body);
    expect(setItemDone(ticked, first.lineKey, true)).toBe(ticked);
  });

  it("keeps CRLF line endings", () => {
    const crlf = "- [ ] **Ana Ruiz** - a\r\n- [ ] **Ana Ruiz** - b\r\n";
    const [a] = ownedItemsIn(crlf, people);
    expect(setItemDone(crlf, a.lineKey, true)).toBe("- [x] **Ana Ruiz** - a\r\n- [ ] **Ana Ruiz** - b\r\n");
  });

  it("returns null when the line is gone", () => {
    expect(setItemDone("- [ ] something else\n", first.lineKey, true)).toBeNull();
  });
});
