import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./coding-session-prompt";
import { buildInventory } from "./tool-inventory";

describe("buildAgentSystemPrompt", () => {
  it("keeps Cairn's base prompt stable across engine plan-mode transitions", () => {
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

  it("names only tools registered on the coding surface (shell is bash everywhere)", async () => {
    const prompt = buildAgentSystemPrompt({
      projectName: "Cairn",
      cwd: "/tmp/cairn",
      taskTitle: "T",
      workspaceId: "w",
      projectId: "p",
    });

    expect(prompt).toContain("`bash`");
    expect(prompt).not.toContain("pwsh");
    expect(prompt).not.toContain("str_replace_editor");

    const inv = await buildInventory();
    const coding = new Set(inv.coding.map((t) => t.name));
    const expectedTools = [
      "get_context",
      "update_tasks",
      "ensure_note",
      "edit_note",
      "create_task",
      "get_user_writing_style",
      "update_user_writing_style",
      "read",
      "write",
      "edit",
      "grep",
      "glob",
      "bash",
      "subagent",
    ];
    for (const name of expectedTools) {
      expect(prompt).toContain(`\`${name}\``);
      expect(coding.has(name), `prompt names ${name} but coding toolset lacks it`).toBe(true);
    }
  });
});
