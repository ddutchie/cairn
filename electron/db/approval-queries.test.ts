import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./schema";
import {
  parkApproval,
  getApprovalItemById,
  listPendingApprovals,
  listApprovalItemsForRun,
  resolveApproval,
  expireStaleApprovals,
  approvalArgsHash,
} from "./approval-queries";

let db: Database.Database;

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  applySchema(db);
});

describe("approval inbox", () => {
  it("parks and reads an approval item", () => {
    const item = parkApproval(db, {
      runId: "run-1",
      tool: "create_task",
      args: { title: "Ship it" },
      title: "Create task",
      body: "Create task 'Ship it'",
    });
    const got = getApprovalItemById(db, item.id)!;
    expect(got.state).toBe("pending");
    expect(got.tool).toBe("create_task");
    expect(got.args).toEqual({ title: "Ship it" });
    expect(got.runId).toBe("run-1");
  });

  it("is idempotent per (run, tool, args) — no duplicate parks", () => {
    const a = parkApproval(db, { runId: "run-1", tool: "create_task", args: { title: "Ship it" } });
    const b = parkApproval(db, { runId: "run-1", tool: "create_task", args: { title: "Ship it" } });
    const c = parkApproval(db, { runId: "run-1", tool: "create_task", args: { title: "Different" } });
    expect(a.id).toBe(b.id);
    expect(c.id).not.toBe(a.id);
    expect(listPendingApprovals(db).length).toBe(2);
  });

  it("lists pending and scoped items", () => {
    parkApproval(db, { runId: "run-1", tool: "ensure_note" });
    parkApproval(db, { runId: "run-2", tool: "update_task" });
    expect(listPendingApprovals(db).length).toBe(2);
    expect(listApprovalItemsForRun(db, "run-1").length).toBe(1);
  });

  it("resolves once — first-responder-wins", () => {
    const item = parkApproval(db, { runId: "run-1", tool: "create_task" });
    const resolved = resolveApproval(db, item.id, "approved_once");
    expect(resolved!.state).toBe("resolved");
    expect(resolved!.resolution).toBe("approved_once");
    expect(resolved!.resolvedAt).not.toBeNull();

    // Second resolution is a no-op (first resolution wins).
    const again = resolveApproval(db, item.id, "denied");
    expect(again!.resolution).toBe("approved_once");
  });

  it("expires stale pending items (fail-closed sweep)", () => {
    parkApproval(db, { runId: "run-1", tool: "create_task" });
    const expired = expireStaleApprovals(db, new Date(Date.now() + 1000).toISOString());
    expect(expired).toBe(1);
    expect(listPendingApprovals(db).length).toBe(0);
  });

  it("generates stable hashes", () => {
    expect(approvalArgsHash("create_task", { title: "x" })).toBe(approvalArgsHash("create_task", { title: "x" }));
    expect(approvalArgsHash("create_task", { title: "x" })).not.toBe(approvalArgsHash("update_task", { title: "x" }));
  });
});

describe("schema v33", () => {
  it("creates the approval_items table with the expected shape", () => {
    const cols = db.prepare("PRAGMA table_info(approval_items)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining([
      "id", "run_id", "session_id", "tool", "args", "args_hash", "kind",
      "title", "body", "state", "resolution", "created_at", "resolved_at",
    ]));
  });
});
