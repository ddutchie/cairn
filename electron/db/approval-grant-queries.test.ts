import { describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { applySchema } from "../db/schema";
import {
  addWorkspaceApprovalGrant,
  getWorkspaceApprovalGrants,
  isWorkspaceGranted,
  deleteWorkspaceApprovalGrant,
  clearWorkspaceApprovalGrants,
  isWildcardExecGrant,
} from "../db/approval-grant-queries";

function makeDb() {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

describe("approval_grants (workspace-persistent Always Allow)", () => {
  it("stores a tool-scoped grant and matches it", () => {
    const db = makeDb();
    expect(getWorkspaceApprovalGrants(db, "w1")).toHaveLength(0);
    const g = addWorkspaceApprovalGrant(db, "w1", "mcp__atlassian__create_issue", null);
    expect(g).toMatchObject({ workspaceId: "w1", tool: "mcp__atlassian__create_issue", target: null });
    expect(isWorkspaceGranted(db, "w1", "mcp__atlassian__create_issue")).toBe(true);
    expect(isWorkspaceGranted(db, "w1", "mcp__atlassian__other")).toBe(false);
    expect(isWorkspaceGranted(db, "w2", "mcp__atlassian__create_issue")).toBe(false);
  });

  it("stores a bash command-scoped grant (exact match, canonicalized outside)", () => {
    const db = makeDb();
    addWorkspaceApprovalGrant(db, "w1", "bash", "ls -la");
    expect(isWorkspaceGranted(db, "w1", "bash", "ls -la")).toBe(true);
    expect(isWorkspaceGranted(db, "w1", "bash", "ls")).toBe(false);
    expect(isWorkspaceGranted(db, "w1", "bash", null)).toBe(false);
    // Tool-scoped bash grant is refused — would be a wildcard.
    expect(isWildcardExecGrant("bash", null)).toBe(true);
    expect(addWorkspaceApprovalGrant(db, "w1", "bash", null)).toBeNull();
  });

  it("is idempotent and ordered oldest-first", () => {
    const db = makeDb();
    addWorkspaceApprovalGrant(db, "w1", "read", null);
    addWorkspaceApprovalGrant(db, "w1", "mcp__x", null);
    const first = getWorkspaceApprovalGrants(db, "w1");
    addWorkspaceApprovalGrant(db, "w1", "read", null); // duplicate
    const second = getWorkspaceApprovalGrants(db, "w1");
    expect(second).toHaveLength(2);
    expect(second.map((r) => r.tool)).toEqual(["read", "mcp__x"]);
    expect(first.length).toBe(second.length);
  });

  it("deletes and clears", () => {
    const db = makeDb();
    const g1 = addWorkspaceApprovalGrant(db, "w1", "read", null)!;
    addWorkspaceApprovalGrant(db, "w1", "bash", "echo hi")!;
    expect(deleteWorkspaceApprovalGrant(db, g1.id)).toBe(true);
    expect(getWorkspaceApprovalGrants(db, "w1")).toHaveLength(1);
    expect(clearWorkspaceApprovalGrants(db, "w1")).toBe(1);
    expect(getWorkspaceApprovalGrants(db, "w1")).toHaveLength(0);
  });

  it("not synced - table exists but is not in SYNCABLE_TABLES", async () => {
    const { SYNCABLE_TABLES } = await import("../../shared/sync/schema");
    expect((SYNCABLE_TABLES as readonly string[]).includes("approval_grants")).toBe(false);
  });
});
