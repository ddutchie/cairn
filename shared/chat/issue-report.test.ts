import { describe, it, expect } from "vitest";
import { buildIssueBody, buildIssueUrl, ISSUE_REPO, ISSUE_TITLE_MAX, ISSUE_URL_MAX } from "./issue-report";

const env = { appVersion: "3.1.2", platform: "macOS", model: "qwen3", contextWindow: 65536, maxOutput: "Auto" as const };

describe("buildIssueBody", () => {
  it("lists the environment and a placeholder when notes are empty", () => {
    const body = buildIssueBody({ title: "t", notes: "  ", env });
    expect(body).toContain("_Describe the problem here._");
    expect(body).toContain("- Cairn: v3.1.2");
    expect(body).toContain("- Model: qwen3");
    expect(body).toContain("- Context window: 65,536 tokens");
    expect(body).toContain("- Max output: Auto");
    expect(body).not.toContain("<details>");
  });

  it("includes surface, settings, turn stats and failed tools when known", () => {
    const body = buildIssueBody({
      title: "t",
      notes: "n",
      env: {
        ...env,
        surface: "Coding agent",
        reasoningEffort: "high",
        approvalMode: "interactive",
        turn: { ttftMs: 812.4, tokensPerSecond: 41.26, outputTokens: 1234 },
        toolCalls: { total: 5, failed: 2, failedNames: ["bash", "mcp__x__y"] },
      },
    });
    expect(body).toContain("- Surface: Coding agent");
    expect(body).toContain("- Reasoning effort: high");
    expect(body).toContain("- Approval mode: interactive");
    expect(body).toContain("- This turn: first token 812 ms, 41.3 tok/s, 1,234 output tokens");
    expect(body).toContain("- Tool calls: 5, 2 failed (bash, mcp__x__y)");
    expect(body).not.toContain("Subagents:");
  });

  it("lists the connected setup by name only when provided", () => {
    const body = buildIssueBody({
      title: "t",
      notes: "n",
      env: {
        ...env,
        setup: {
          mcpServers: [{ name: "Confluence", enabled: true, tools: 12 }, { name: "Notion", enabled: false }],
          tools: { total: 74, bySource: { cairn: 60, coding: 14 } },
          skills: Array.from({ length: 22 }, (_, i) => `s${i}`),
        },
      },
    });
    expect(body).toContain("- MCP servers: Confluence (enabled, 12 tools), Notion (disabled)");
    expect(body).toContain("- Tools registered: 74 (cairn 60, coding 14)");
    expect(body).toContain("s19, +2 more");
    expect(buildIssueBody({ title: "t", notes: "n", env: { ...env, setup: { mcpServers: [], skills: [] } } })).toContain("- MCP servers: none");
  });

  it("reports subagents for chat and skips tool calls when there were none", () => {
    const body = buildIssueBody({ title: "t", notes: "n", env: { ...env, surface: "Chat", subagents: false, toolCalls: { total: 0, failed: 0, failedNames: [] } } });
    expect(body).toContain("- Subagents: off");
    expect(body).not.toContain("Tool calls:");
  });

  it("omits unknown environment lines", () => {
    const body = buildIssueBody({ title: "t", notes: "x", env: { appVersion: "1", platform: "Linux" } });
    expect(body).not.toContain("Model:");
    expect(body).not.toContain("Context window:");
  });

  it("fences the reply with more backticks than it contains", () => {
    const body = buildIssueBody({ title: "t", notes: "n", reply: "see ```js\ncode\n```", env });
    expect(body).toContain("````\nsee ```js");
    expect(body).toContain("<summary>Assistant reply</summary>");
  });
});

describe("buildIssueUrl", () => {
  it("targets the repo's new-issue page with an encoded title and body", () => {
    const { url, truncated } = buildIssueUrl({ title: "Bad & wrong", notes: "n", env });
    expect(url.startsWith(`https://github.com/${ISSUE_REPO}/issues/new?`)).toBe(true);
    expect(new URL(url).searchParams.get("title")).toBe("Bad & wrong");
    expect(truncated).toBe(false);
  });

  it("falls back to a default title", () => {
    expect(new URL(buildIssueUrl({ title: " ", notes: "", env }).url).searchParams.get("title")).toBeTruthy();
  });

  it("trims a long reply to fit the URL limit and says so", () => {
    const { url, truncated } = buildIssueUrl({ title: "t", notes: "n", reply: "word ".repeat(5000), env });
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(truncated).toBe(true);
    expect(new URL(url).searchParams.get("body")).toContain("Assistant reply (truncated)");
  });

  it("trims runaway notes as a last resort", () => {
    const { url, truncated } = buildIssueUrl({ title: "t", notes: "é".repeat(20000), env });
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(truncated).toBe(true);
  });

  it("bounds an unreasonably long title so the link still fits", () => {
    const { url, truncated } = buildIssueUrl({ title: "é".repeat(20000), notes: "n", env });
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(new URL(url).searchParams.get("title")).toHaveLength(ISSUE_TITLE_MAX);
    expect(truncated).toBe(true);
  });

  it("drops the optional setup list when it alone overflows the limit", () => {
    const mcpServers = Array.from({ length: 400 }, (_, i) => ({ name: `server-${i}-${"x".repeat(30)}`, enabled: true }));
    const { url, truncated } = buildIssueUrl({ title: "t", notes: "n", env: { ...env, setup: { mcpServers, skills: [] } } });
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(new URL(url).searchParams.get("body")).not.toContain("MCP servers");
    expect(truncated).toBe(true);
  });
});
