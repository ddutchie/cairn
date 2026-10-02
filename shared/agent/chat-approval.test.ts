import { describe, expect, it } from "vitest";
import { chatToolNeedsApproval, resolveChatApprovalPolicy } from "./chat-approval";

describe("chat approval policy", () => {
  it("safe: deletes and connectors ask; other Cairn writes run", () => {
    expect(chatToolNeedsApproval("delete_note", "safe")).toBe(true);
    expect(chatToolNeedsApproval("delete_project", "safe")).toBe(true);
    expect(chatToolNeedsApproval("mcp__jira__createIssue", "safe")).toBe(true);
    expect(chatToolNeedsApproval("ensure_note", "safe")).toBe(false);
    expect(chatToolNeedsApproval("update_task", "safe")).toBe(false);
  });

  it("external: only connectors (and shell-capable delegation) ask", () => {
    expect(chatToolNeedsApproval("delete_task", "external")).toBe(false);
    expect(chatToolNeedsApproval("svc__slack__send_message", "external")).toBe(true);
    expect(chatToolNeedsApproval("read_mcp_resource", "external")).toBe(true);
    expect(chatToolNeedsApproval("subagent", "external")).toBe(true);
  });

  it("allow-all: nothing asks", () => {
    for (const name of ["delete_note", "mcp__jira__createIssue", "subagent", "ensure_note"]) {
      expect(chatToolNeedsApproval(name, "allow-all")).toBe(false);
    }
  });

  it("unknown or missing values resolve to safe", () => {
    expect(resolveChatApprovalPolicy(undefined)).toBe("safe");
    expect(resolveChatApprovalPolicy("bogus")).toBe("safe");
    expect(resolveChatApprovalPolicy("external")).toBe("external");
  });
});
