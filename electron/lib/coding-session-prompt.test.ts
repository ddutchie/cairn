import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./coding-session-prompt";

describe("buildAgentSystemPrompt", () => {
  it("keeps Cairn's base prompt stable across dsh plan-mode transitions", () => {
    const context = {
      projectName: "Cairn",
      cwd: "/tmp/cairn",
      taskTitle: "Adopt plan mode",
      workspaceId: "workspace",
      projectId: "project",
    };

    expect(buildAgentSystemPrompt({ ...context, mode: "plan" }))
      .toBe(buildAgentSystemPrompt({ ...context, mode: "execute" }));
  });
});
