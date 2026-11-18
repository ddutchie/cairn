import { describe, expect, it } from "vitest";
import { humanizeConnectorTool, humanizeSearchResult, humanizeTool, humanizedRunStep, humanizedText } from "./humanize-tool";

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
    expect(humanizedText("skill", {})).toBe("Listed the skills");
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

    it("update_task: padded ids resolve, whitespace-only title edits are not renames", () => {
      expect(humanizedText("update_task", { cardId: "  c1 ", title: "Ship it" }, lookup)).toBe("Renamed task Fix the ring to “Ship it”");
      expect(humanizedText("update_task", { cardId: "c1", title: "  Fix the ring " }, lookup)).toBe("Updated task Fix the ring");
    });

    it("falls back to the raw id when the entity isn't loaded", () => {
      expect(humanizedText("patch_note", { noteId: "unknown-id" }, lookup)).toBe("Updated note unknown-id");
      expect(humanizedText("patch_note", { noteId: "n1" })).toBe("Updated note n1");
    });
  });
});

describe("humanizedRunStep", () => {
  it("words a run's step like the chat transcript, naming the connector", () => {
    expect(humanizedRunStep("today_read")).toBe("Read the brief so far");
    expect(humanizedRunStep("today_upsert", { items: [{}, {}, {}] })).toBe("Added 3 items to the brief");
    expect(humanizedRunStep("mcp__tZ7lQzgCms_3__ask_work_iq", { question: "x" }, "Work IQ")).toBe("Work IQ · Ask");
    expect(humanizedRunStep("mcp__s1__search_messages", { query: "release" }, undefined, "Slack · Search messages")).toBe("Slack · Search messages release");
    expect(humanizedRunStep("mcp__s1__search_messages")).toBe("Search messages");
  });

  it("describes a search by what it asked for, never a placeholder", () => {
    expect(humanizeTool("search_notes", { query: "login" })).toEqual({ pre: "Searched notes for", obj: "“login”" });
    expect(humanizeTool("search_notes", { query: "login", mode: "semantic" }).pre).toBe("Searched notes by meaning for");
    expect(humanizeTool("search_notes", { query: "", folder: "Plans" })).toEqual({ pre: "Listed notes in", obj: "Plans" });
    expect(humanizeTool("search_notes", { query: "" })).toEqual({ pre: "Listed notes" });
    expect(humanizeTool("search_tasks", { tag: "bug" })).toEqual({ pre: "Listed tasks tagged", obj: "bug" });
    expect(humanizeTool("search_tasks", { filter: "ready" })).toEqual({ pre: "Listed ready tasks" });
    expect(JSON.stringify(humanizeTool("search_notes", {}))).not.toContain("a phrase");
  });

  it("names an ask_questions call by how many questions it asked", () => {
    expect(humanizeTool("ask_questions", { questions: [{}, {}] })).toEqual({ pre: "Asked", obj: "2 questions" });
    expect(humanizeTool("ask_questions", { questions: [{}] }).obj).toBe("1 question");
  });

  it("words a finished search with its result count", () => {
    expect(humanizeSearchResult("notes", { query: "login" }, 3)).toEqual({ pre: "Found 3 notes for", obj: "“login”" });
    expect(humanizeSearchResult("notes", { query: "login" }, 1).pre).toBe("Found 1 note for");
    expect(humanizeSearchResult("notes", { query: "login" }, 0)).toEqual({ pre: "No notes matched", obj: "“login”" });
    expect(humanizeSearchResult("tasks", { filter: "ready" }, 2)).toEqual({ pre: "Found 2 ready tasks" });
    expect(humanizeSearchResult("tasks", { filter: "ready" }, 0)).toEqual({ pre: "No ready tasks" });
    expect(humanizeSearchResult("notes", { folder: "Plans" }, 4)).toEqual({ pre: "Found 4 notes in", obj: "Plans" });
    expect(humanizeSearchResult("notes", {}, 0)).toEqual({ pre: "No notes found" });
  });
});
