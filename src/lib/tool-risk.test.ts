import { describe, expect, it } from "vitest";
import { APPROVAL_SAFE_TOOLS, approvalPreview, riskForTool, approvalGrantScope, approvalScopeLabel } from "./tool-risk";

describe("tool approval presentation rules", () => {
  it("classifies local, executable, and external tools", () => {
    expect(riskForTool("read")).toBe("READ");
    expect(riskForTool("write")).toBe("WRITE_LOCAL");
    expect(riskForTool("bash")).toBe("EXEC");
    expect(riskForTool("mcp__tavily__search")).toBe("EXTERNAL");
  });

  it("clamps previews by both line and character bounds", () => {
    const preview = approvalPreview("bash", { command: Array.from({ length: 8 }, (_, i) => `${i}: ${"x".repeat(90)}`).join("\n") });
    expect(preview.split("\n")).toHaveLength(5);
    expect(preview.length).toBeLessThanOrEqual(421);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("handles missing bash and write preview values", () => {
    expect(approvalPreview("bash", {})).toBe("");
    expect(approvalPreview("write", {})).toBe("");
  });

  // approval-grant-scope: which standing-grant affordance the approval card
  // offers per tool. This is the security-relevant part — a wrong mapping would
  // let a consequential action be pre-authorised too broadly.
  it("scopes a bash grant to the exact command", () => {
    expect(approvalGrantScope("bash")).toBe("command");
  });

  it("scopes local-write and external grants to the session", () => {
    expect(approvalGrantScope("write")).toBe("session");
    expect(approvalGrantScope("update_task")).toBe("session");
    expect(approvalGrantScope("mcp__linear__create_issue")).toBe("session");
    expect(approvalGrantScope("svc__slack__post")).toBe("session");
  });

  it("offers no standing grant for reads or non-bash exec", () => {
    expect(approvalGrantScope("read")).toBe("none");
    expect(approvalGrantScope("grep")).toBe("none");
    // subagent is EXEC but not bash → no command-scoped grant, and EXEC is
    // excluded from session grants, so one-off only.
    expect(approvalGrantScope("subagent")).toBe("none");
  });

  it("states where each action reaches, distinguishing local from external", () => {
    expect(approvalScopeLabel("read")).toContain("stays on this device");
    expect(approvalScopeLabel("write")).toContain("stays on this device");
    expect(approvalScopeLabel("bash")).toContain("runs on this device");
    expect(approvalScopeLabel("mcp__tavily__search")).toContain("leaves this device");
  });

  it("uses platform-neutral wording (no hardcoded 'Mac')", () => {
    // Cairn is a cross-platform desktop app — the approval copy must not assume macOS.
    for (const tool of ["read", "write", "bash", "mcp__x__y"]) {
      expect(approvalScopeLabel(tool)).not.toMatch(/\bMac\b/);
    }
  });
});

// Drift regressions (audit G7): these were labelled READ/no-grant by the old
// renderer-only taxonomy while the main gate asked for them.
describe("taxonomy drift fixes (shared source of truth)", () => {
  it("labels dsh editor/todo writes as session-grantable local writes", () => {
    expect(riskForTool("str_replace_editor")).toBe("WRITE_LOCAL");
    expect(approvalGrantScope("str_replace_editor")).toBe("session");
    expect(riskForTool("todo_write")).toBe("WRITE_LOCAL");
  });

  it("labels Cairn data deletes as writes, not reads", () => {
    expect(riskForTool("delete_note")).toBe("WRITE_LOCAL");
    expect(riskForTool("delete_task")).toBe("WRITE_LOCAL");
    expect(approvalGrantScope("delete_note")).toBe("session");
  });

  it("still classifies every approval-safe tool as READ", () => {
    for (const name of APPROVAL_SAFE_TOOLS) expect(riskForTool(name)).toBe("READ");
  });
});
