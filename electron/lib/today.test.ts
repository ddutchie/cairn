import { describe, it, expect } from "vitest";
import { todayAllowsTool } from "./today";

describe("todayAllowsTool", () => {
  it("allows Cairn and engine reads", () => {
    for (const t of ["list_tasks", "get_item", "search_notes", "read", "grep", "web_fetch"]) expect(todayAllowsTool(t)).toBe(true);
  });
  it("denies local writes and shell", () => {
    for (const t of ["create_task", "edit_note", "bash", "write", "edit", "delete"]) expect(todayAllowsTool(t)).toBe(false);
  });
  it("allows read-like connector tools", () => {
    for (const t of ["mcp__slack__search_messages", "mcp__workiq__ask_work_iq", "mcp__github__list_pull_requests", "mcp__atlassian__searchJiraIssuesUsingJql", "mcp__atlassian__getJiraIssue"]) {
      expect(todayAllowsTool(t)).toBe(true);
    }
  });
  it("denies connector tools that change things, even with a read verb", () => {
    for (const t of ["mcp__slack__send_message", "mcp__slack__post_message", "mcp__github__create_pull_request_review", "mcp__outlook__get_and_delete_mail", "mcp__x__do_thing", "mcp__atlassian__editJiraIssue", "mcp__atlassian__createConfluenceContent"]) {
      expect(todayAllowsTool(t)).toBe(false);
    }
  });
  it("keeps every tool a real Today run used (server ids, not names, in connector tools)", () => {
    for (const t of [
      "get_context", "get_user_writing_style", "search_tasks", "search_notes", "get_item",
      "mcp__WF1vubI3qu52__slack_list_user_channels", "mcp__WF1vubI3qu52__slack_search_public_and_private",
      "mcp__WF1vubI3qu52__slack_read_channel", "mcp__WF1vubI3qu52__slack_search_channels",
      "mcp__Q9x__ask_work_iq", "mcp__A1__getAccessibleAtlassianResources", "mcp__A1__searchConfluenceUsingCql", "mcp__A1__getConfluencePage",
    ]) expect(todayAllowsTool(t)).toBe(true);
  });
});
