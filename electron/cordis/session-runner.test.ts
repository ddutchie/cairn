import { describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { getSessionProfile } from "../db/queries";
import { runCordisSession } from "./session-runner";

describe("runCordisSession profile metadata", () => {
  it("persists the profile before preparing the runtime", async () => {
    const db: Database.Database = new BetterSqlite3(":memory:");
    applySchema(db);

    await expect(runCordisSession({
      ctx: {} as never,
      db,
      req: {} as never,
      sessionId: "automation-session-1",
      profileId: "automation-dev",
      workspaceId: "workspace-1",
      projectId: "project-1",
      cwd: "/workspace/project",
      llmConfig: {} as never,
      setup: async () => undefined,
      open: async () => ({ agent: {} } as never),
      run: async () => undefined,
    })).rejects.toBeTruthy();

    expect(getSessionProfile(db, "automation-session-1")).toMatchObject({
      sessionId: "automation-session-1",
      profile: "automation-dev",
      workspaceId: "workspace-1",
      projectId: "project-1",
      cwd: "/workspace/project",
    });
    db.close();
  });
});
