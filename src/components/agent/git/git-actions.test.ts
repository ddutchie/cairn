import { describe, expect, it } from "vitest";
import { discardMessage } from "./git-actions";
import type { GitStatusData } from "./git-helpers";

const f = (path: string) => ({ path, status: "M" }) as GitStatusData["staged"][number];
const status = {
  staged: [f("both.ts"), f("staged.ts")],
  unstaged: [f("both.ts"), f("mod.ts")],
  untracked: [f("new.ts")],
} as unknown as GitStatusData;

describe("discardMessage", () => {
  it("describes single files by what discarding them does", () => {
    expect(discardMessage(status, ["new.ts"])).toMatch(/^Delete the untracked file/);
    expect(discardMessage(status, ["both.ts"])).toMatch(/Staged changes will be preserved/);
    expect(discardMessage(status, ["staged.ts"])).toMatch(/revert the file to its HEAD state/);
    expect(discardMessage(status, ["mod.ts"])).toMatch(/^Discard changes in mod.ts/);
  });

  it("describes bulk discards", () => {
    expect(discardMessage(status, ["new.ts"].concat("new.ts"))).toMatch(/^Delete these 2 untracked files/);
    expect(discardMessage(status, ["both.ts", "mod.ts"])).toMatch(/partially staged files will be preserved/);
    expect(discardMessage(status, ["mod.ts", "new.ts"])).toMatch(/^Discard changes in these 2 files/);
  });
});
