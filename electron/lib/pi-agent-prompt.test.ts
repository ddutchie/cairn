import { describe, expect, it } from "vitest";
import { buildPiAgentSystemPrompt } from "./pi-agent-prompt";

describe("buildPiAgentSystemPrompt", () => {
  it("keeps Cairn's base prompt stable across dsh plan-mode transitions", () => {
    const context = {
      projectName: "Cairn",
      cwd: "/tmp/cairn",
      taskTitle: "Adopt plan mode",
      workspaceId: "workspace",
      projectId: "project",
    };

    expect(buildPiAgentSystemPrompt({ ...context, mode: "plan" }))
      .toBe(buildPiAgentSystemPrompt({ ...context, mode: "execute" }));
  });
});
