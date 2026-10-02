import { describe, expect, it } from "vitest";
import { humanizeConnectorTool, humanizeTool, humanizedText } from "./humanize-tool";

describe("humanizeTool", () => {
  it("turns coding tools into concise English summaries", () => {
    expect(humanizedText("write", { path: "runbook.md" })).toBe("Wrote runbook.md");
    expect(humanizedText("grep", { pattern: "retry" })).toBe("Searched the code for “retry”");
  });

  it("prefers the model's description for shell commands", () => {
    expect(humanizedText("bash", { command: "rm -rf tmp", description: "Cleaned the generated files" }))
      .toBe("Cleaned the generated files");
  });

  it("handles unknown and external tools without exposing an argument dump", () => {
    expect(humanizeTool("svc__slack__post_message", { channel: "alerts", text: "hello" }))
      .toEqual({ pre: "Post message", obj: "alerts" });
    expect(humanizedText("mystery_tool")).toBe("Used mystery_tool");
  });

  it("names the connector action and its target, camelCase included", () => {
    expect(humanizeTool("mcp__atl1__createConfluencePage", { spaceId: "123", title: "Q3 plan", body: "…" }))
      .toEqual({ pre: "Create confluence page", obj: "Q3 plan" });
    expect(humanizeTool("mcp__atl1__getAccessibleAtlassianResources", {}))
      .toEqual({ pre: "Get accessible atlassian resources" });
    expect(humanizeTool("mcp__BZ__search-designs", { query: "logo" })).toEqual({ pre: "Search designs", obj: "logo" });
  });

  it("drops the connector's own name from the action", () => {
    expect(humanizeConnectorTool("mcp__a__createConfluencePage", { title: "Q3" }, "Confluence"))
      .toEqual({ pre: "Create page", obj: "Q3" });
    expect(humanizeConnectorTool("mcp__j__searchJiraIssuesUsingJql", {}, "Jira").pre).toBe("Search issues using jql");
    expect(humanizeConnectorTool("mcp__g__google_drive_list_files", {}, "Google Drive").pre).toBe("List files");
    // Whole words only, and never empty.
    expect(humanizeConnectorTool("mcp__j__jiraform_submit", {}, "Jira").pre).toBe("Jiraform submit");
    expect(humanizeConnectorTool("mcp__l__linear", {}, "Linear").pre).toBe("Linear");
    // Bare (un-namespaced) connector tool names are humanized too, not "Used send_message".
    expect(humanizeConnectorTool("send_message", { channel: "alerts" }, "Slack")).toEqual({ pre: "Send message", obj: "alerts" });
    expect(humanizeConnectorTool("mcp__a__getAccessibleAtlassianResources", {}, "Confluence").pre)
      .toBe("Get accessible atlassian resources");
  });

  it("names the loaded skill", () => {
    expect(humanizedText("skill", { name: "pdf" })).toBe("Loaded skill pdf");
  });

  it("bounds long display objects", () => {
    const result = humanizeTool("read", { path: "a".repeat(300) });
    expect(result.obj).toHaveLength(160);
    expect(result.obj?.endsWith("…")).toBe(true);
  });

  describe("Cairn tools resolve ids to names", () => {
    const lookup = {
      note: (id: string) => ({ n1: "Release plan", n2: "Ideas" } as Record<string, string>)[id],
      task: (id: string) => ({ c1: "Fix the ring" } as Record<string, string>)[id],
      project: (id: string) => ({ p1: "Cairn" } as Record<string, string>)[id],
      column: (id: string) => ({ done: "Done" } as Record<string, string>)[id],
    };

    it("shows the note title for an id-only note edit", () => {
      expect(humanizedText("patch_note", { noteId: "n1", oldString: "a", newString: "b" }, lookup)).toBe("Updated note Release plan");
      expect(humanizedText("append_to_note", { noteId: "n2", content: "x" }, lookup)).toBe("Added to note Ideas");
      expect(humanizedText("delete_note", { noteId: "n1" }, lookup)).toBe("Deleted note Release plan");
      expect(humanizedText("rename_note", { noteId: "n1", newTitle: "Launch plan" }, lookup)).toBe("Renamed note Release plan to “Launch plan”");
    });

    it("shows task, column and project names", () => {
      expect(humanizedText("update_task", { cardId: "c1", columnId: "done" }, lookup)).toBe("Moved task Fix the ring to Done");
      expect(humanizedText("update_task", { cardId: "c1", priority: "high" }, lookup)).toBe("Updated task Fix the ring");
      expect(humanizedText("delete_task", { cardId: "c1" }, lookup)).toBe("Deleted task Fix the ring");
      expect(humanizedText("link_note_to_task", { noteId: "n1", cardId: "c1" }, lookup)).toBe("Linked note Release plan to Fix the ring");
      expect(humanizedText("delete_project", { projectId: "p1" }, lookup)).toBe("Deleted project Cairn");
      expect(humanizedText("bulk_update_task_status", { cardIds: ["c1", "c2"], targetColumnId: "done" }, lookup)).toBe("Moved 2 tasks to Done");
    });

    it("falls back to the raw id when the entity isn't loaded", () => {
      expect(humanizedText("patch_note", { noteId: "unknown-id" }, lookup)).toBe("Updated note unknown-id");
      expect(humanizedText("patch_note", { noteId: "n1" })).toBe("Updated note n1");
    });
  });
});
