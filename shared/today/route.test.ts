import { describe, it, expect } from "vitest";
import { channelFor, operationWords, sendCandidates } from "./route";

describe("channelFor", () => {
  it("reads the channel from source and target", () => {
    expect(channelFor("Outlook via Work IQ")).toBe("email");
    expect(channelFor("Slack DM")).toBe("slack");
    expect(channelFor("Cairn", "Teams chat with Kitty")).toBe("teams");
    expect(channelFor("Cairn board")).toBe("board");
    expect(channelFor("Anything", undefined, "cards")).toBe("board");
    expect(channelFor("Linear")).toBe("other");
  });
});

describe("sendCandidates", () => {
  const defs = [
    { name: "mcp__slack__slack_post_message" },
    { name: "mcp__slack__slack_search_messages" },
    { name: "mcp__slack__slack_reply_to_thread" },
    { name: "mcp__workiq__ask", description: "Ask about your email and meetings" },
    { name: "mcp__graph__sendMail", description: "Send an Outlook email" },
    { name: "mcp__atlassian__addCommentToJiraIssue" },
  ];

  it("keeps send-like tools on the channel, replies first", () => {
    expect(sendCandidates(defs, "slack").map((t) => t.op)).toEqual(["slack_reply_to_thread", "slack_post_message"]);
  });

  it("matches the channel in a tool's description", () => {
    expect(sendCandidates(defs, "email").map((t) => t.name)).toEqual(["mcp__graph__sendMail"]);
  });

  it("finds nothing when the connectors only read", () => {
    expect(sendCandidates([{ name: "mcp__workiq__ask", description: "Outlook mail and calendar" }], "email")).toEqual([]);
  });

  it("never offers connector tools for the board", () => {
    expect(sendCandidates(defs, "board")).toEqual([]);
  });

  it("splits camelCase operations", () => {
    expect(operationWords("mcp__atlassian__addCommentToJiraIssue")).toBe("add_Comment_To_Jira_Issue");
    expect(sendCandidates(defs, "jira").map((t) => t.server)).toEqual(["atlassian"]);
  });
  it("matches on the server's name when tool names carry an id", () => {
    const ids = [{ name: "mcp__K7q__send_message" }, { name: "mcp__Z2p__send_message" }];
    const names = { K7q: "Outlook Mail", Z2p: "Slack" };
    expect(sendCandidates(ids, "email", names).map((t) => [t.name, t.server])).toEqual([["mcp__K7q__send_message", "Outlook Mail"]]);
  });
});
