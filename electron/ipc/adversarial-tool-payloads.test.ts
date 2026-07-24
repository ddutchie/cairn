/**
 * Adversarial payload battery for the LLM tool-call pipeline.
 *
 * These fixtures target each suspected failure mode reported from real broken
 * agent turns. The harness flows a RAW tool-call `arguments` string through the
 * exact path a streamed call takes:
 *
 *     raw JSON string → parseToolArgs() → executeTool(ensure_note | patch_note)
 *
 * The unifying invariant under test: every tool call either (a) parses and does
 * the right thing, or (b) fails LOUDLY with a structured error. It must NEVER
 * silently return {} or persist a partial/garbled write.
 */

import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, createNote, getNoteById } from "../db/queries";
import { executeTool } from "./chat-executor";
import { parseToolArgs } from "../lib/parse-tool-args";
import type { LLMConfig } from "../lib/llm";
import type { ChatRequest } from "../lib/tools";

const llmConfig: LLMConfig = { baseUrl: "http://localhost", model: "test", apiKey: "" };
const chatReq: ChatRequest = { message: "", workspaceId: "ws1", projectId: "proj1", threadId: "t1" };
function noEmit() {}

interface Ctx {
  db: Database.Database;
  workspacePath: string;
}

/**
 * Fresh in-memory DB + a UNIQUE on-disk workspace dir per test. The note tools
 * write real `.md` files, so a shared workspace path would race across vitest's
 * parallel test files (a concurrent write's `.tmp` file breaks the note-file
 * directory walk). An isolated temp dir keeps every test hermetic.
 */
function makeCtx(): Ctx {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws1", name: "Workspace" });
  createProject(db, { id: "qMM4mUBTnZGz", workspaceId: "ws1", name: "Project" });
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-adv-"));
  return { db, workspacePath };
}

/** Run a raw streamed-arguments string through parse → execute, like the real loop. */
async function runRaw(ctx: Ctx, name: string, rawArgs: string) {
  const parsed = parseToolArgs(rawArgs);
  if (!parsed.ok) return { stage: "parse" as const, error: parsed.error };
  const result = await executeTool(ctx.db, chatReq, ctx.workspacePath, llmConfig, name, parsed.value as never, noEmit);
  return { stage: "execute" as const, result: result as Record<string, unknown>, repaired: parsed.repaired };
}

// ── Case 1: nested code fences ────────────────────────────────────────────────

describe("Case 1 — nested code fences", () => {
  // A well-formed JSON payload whose content contains an outer ```markdown fence
  // wrapping an inner ```json fence. The fences are INSIDE the string value and
  // properly escaped, so this is valid JSON and must round-trip byte-identically.
  const content =
    "# Heading\n\nHere is a draft post:\n\n```markdown\nHi #channel :wave:\n\n```json\n{\"nested\": true}\n```\n\nEnd of post.\n```\n\nDone.";
  const raw = JSON.stringify({ projectId: "qMM4mUBTnZGz", title: "Fence Test", content });

  it("parses valid JSON with embedded fences WITHOUT any repair", () => {
    const parsed = parseToolArgs(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.repaired).toBe(false); // must NOT mistake inner fences for a wrapper
      expect(parsed.value.content).toBe(content);
    }
  });

  it("round-trips: stored content is byte-identical to input", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    const out = await runRaw(ctx, "ensure_note", raw);
    expect(out.stage).toBe("execute");
    if (out.stage === "execute") {
      const note = getNoteById(db, out.result.id as string) as Record<string, unknown>;
      expect(note.content).toBe(content);
    }
  });

  it("valid JSON whose content is ITSELF a fenced block is preserved byte-for-byte (never stripped)", () => {
    // The content legitimately starts and ends with a code fence. We must never
    // strip it — content is data, not a wrapper to unwrap.
    const fencedContent = "```json\n{\"nested\": true}\n```";
    const rawFenced = JSON.stringify({ projectId: "qMM4mUBTnZGz", title: "Fenced Content", content: fencedContent });
    const parsed = parseToolArgs(rawFenced);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.repaired).toBe(false);
      expect(parsed.value.content).toBe(fencedContent);
    }
  });
});

// ── Case 2: unicode / offsets in patch_note ───────────────────────────────────

describe("Case 2 — unicode that shifts byte offsets (patch_note)", () => {
  const original =
    "Status: \uD83D\uDFE2 Active \u2014 collaborative builds yield 10x throughput \uD83E\uDD1D \u27A1\uFE0F next steps below.";

  it("replaces a codepoint-heavy oldString and reports replacement count", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    createNote(db, { id: "TEST", projectId: "qMM4mUBTnZGz", workspaceId: "ws1", title: "U", content: original, contentText: original });
    const raw = JSON.stringify({
      noteId: "TEST",
      oldString: "\uD83D\uDFE2 Active \u2014 collaborative builds yield 10x",
      newString: "\uD83D\uDFE1 Pending \u2014 ~1 hour/week",
    });
    const out = await runRaw(ctx, "patch_note", raw);
    expect(out.stage).toBe("execute");
    if (out.stage === "execute") {
      expect(out.result.replacements).toBe(1);
      const note = getNoteById(db, "TEST") as Record<string, unknown>;
      expect(note.content).toContain("\uD83D\uDFE1 Pending");
      expect(note.content).not.toContain("\uD83D\uDFE2 Active");
    }
  });

  it("returns an explicit 'not found' (not 0 silent replacements) when oldString is absent", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    createNote(db, { id: "TEST", projectId: "qMM4mUBTnZGz", workspaceId: "ws1", title: "U", content: original, contentText: original });
    const raw = JSON.stringify({ noteId: "TEST", oldString: "does not exist \uD83D\uDE80", newString: "x" });
    const out = await runRaw(ctx, "patch_note", raw);
    expect(out.stage).toBe("execute");
    if (out.stage === "execute") {
      expect(out.result).toHaveProperty("error");
      expect(String(out.result.error)).toMatch(/not found/i);
      // Original must be untouched.
      const note = getNoteById(db, "TEST") as Record<string, unknown>;
      expect(note.content).toBe(original);
    }
  });

  it("handles CRLF vs LF and non-breaking spaces as distinct codepoints", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    const crlf = "line1\r\nline2\u00A0end"; // NBSP before 'end'
    createNote(db, { id: "TEST", projectId: "qMM4mUBTnZGz", workspaceId: "ws1", title: "U", content: crlf, contentText: crlf });
    const raw = JSON.stringify({ noteId: "TEST", oldString: "line2\u00A0end", newString: "line2 end" });
    const out = await runRaw(ctx, "patch_note", raw);
    if (out.stage === "execute") {
      expect(out.result.replacements).toBe(1);
      const note = getNoteById(db, "TEST") as Record<string, unknown>;
      expect(note.content).toBe("line1\r\nline2 end");
    }
  });
});

// ── Case 3: empty / partial arguments ─────────────────────────────────────────

describe("Case 3 — empty / partial arguments must fail loud", () => {
  it("{} → structured missing_required_field (projectId)", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    const out = await runRaw(ctx, "ensure_note", "{}");
    expect(out.stage).toBe("execute");
    if (out.stage === "execute") {
      expect(out.result.error).toBe("missing_required_field");
      expect(out.result.field).toBe("projectId");
    }
  });

  it("missing projectId → structured error naming projectId", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    const out = await runRaw(ctx, "ensure_note", JSON.stringify({ title: "Orphan", content: "no projectId here" }));
    if (out.stage === "execute") {
      expect(out.result.error).toBe("missing_required_field");
      expect(out.result.field).toBe("projectId");
    }
  });

  it("blank title → structured error naming title", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    const out = await runRaw(ctx, "ensure_note", JSON.stringify({ projectId: "qMM4mUBTnZGz", title: "" }));
    if (out.stage === "execute") {
      expect(out.result.error).toBe("missing_required_field");
      expect(out.result.field).toBe("title");
    }
  });
});

// ── Case 4: clobber guard ─────────────────────────────────────────────────────

describe("Case 4 — clobber guard against wiping a large note", () => {
  const bigDoc = "# Big Doc\n\n" + "content paragraph. ".repeat(700); // ~12KB

  it("refuses to overwrite a 12KB note with a 3-char body", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    createNote(db, { id: "big1", projectId: "qMM4mUBTnZGz", workspaceId: "ws1", title: "IGS AIM Peer Learning and Activation", content: bigDoc, contentText: bigDoc });
    const raw = JSON.stringify({ projectId: "qMM4mUBTnZGz", title: "IGS AIM Peer Learning and Activation", content: "wip" });
    const out = await runRaw(ctx, "ensure_note", raw);
    if (out.stage === "execute") {
      expect(out.result.error).toBe("possible_accidental_overwrite");
      expect(out.result.existing_length).toBe(bigDoc.length);
      // Doc intact.
      const note = getNoteById(db, "big1") as Record<string, unknown>;
      expect(note.content).toBe(bigDoc);
    }
  });

  it("permits the same overwrite when overwrite:true is set", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    createNote(db, { id: "big1", projectId: "qMM4mUBTnZGz", workspaceId: "ws1", title: "Doc", content: bigDoc, contentText: bigDoc });
    const raw = JSON.stringify({ projectId: "qMM4mUBTnZGz", title: "Doc", content: "wip", overwrite: true });
    const out = await runRaw(ctx, "ensure_note", raw);
    if (out.stage === "execute") {
      expect(out.result.action).toBe("updated");
      const note = getNoteById(db, "big1") as Record<string, unknown>;
      expect(note.content).toBe("wip");
    }
  });
});

// ── Case 5: quote / escape torture ────────────────────────────────────────────

describe("Case 5 — quote / escape torture string", () => {
  const content =
    'He said "AI theater" and used `inline code`, a path C:\\Users\\x, an escaped quote \\" and a trailing backslash \\\\';
  // Build the raw JSON via JSON.stringify so escaping is correct end-to-end.
  const raw = JSON.stringify({ projectId: "qMM4mUBTnZGz", title: "Quote Test", content });

  it("round-trips quotes, backslashes, and paths byte-identically", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    const out = await runRaw(ctx, "ensure_note", raw);
    expect(out.stage).toBe("execute");
    if (out.stage === "execute") {
      const note = getNoteById(db, out.result.id as string) as Record<string, unknown>;
      expect(note.content).toBe(content);
    }
  });
});

// ── Case 6: truncation (mid-stream cutoff) ────────────────────────────────────

describe("Case 6 — truncated payload must be rejected, never partially persisted", () => {
  const truncated = '{ "projectId": "qMM4mUBTnZGz", "title": "Trunc", "content": "line one\\nline two\\nline th';

  it("fails at the parse stage (structured error) and writes nothing", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    const out = await runRaw(ctx, "ensure_note", truncated);
    expect(out.stage).toBe("parse");
    if (out.stage === "parse") {
      expect(out.error).toMatch(/malformed tool-call arguments/i);
    }
    // Nothing persisted.
    const count = (db.prepare("SELECT COUNT(*) c FROM notes").get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

// ── Case 7: control chars & large payloads ────────────────────────────────────

describe("Case 7 — control chars and large payloads", () => {
  it("repairs a raw literal newline inside a string value and round-trips it", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    // A REAL newline typed inside the content value → invalid JSON as streamed.
    const raw = '{"projectId":"qMM4mUBTnZGz","title":"Ctrl","content":"line one\nline two"}';
    const out = await runRaw(ctx, "ensure_note", raw);
    expect(out.stage).toBe("execute");
    if (out.stage === "execute") {
      expect(out.repaired).toBe(true);
      const note = getNoteById(db, out.result.id as string) as Record<string, unknown>;
      expect(note.content).toBe("line one\nline two");
    }
  });

  it("repairs a raw literal tab inside a string value", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    const raw = '{"projectId":"qMM4mUBTnZGz","title":"Tab","content":"col1\tcol2"}';
    const out = await runRaw(ctx, "ensure_note", raw);
    if (out.stage === "execute") {
      const note = getNoteById(db, out.result.id as string) as Record<string, unknown>;
      expect(note.content).toBe("col1\tcol2");
    }
  });

  it("accepts a ~100KB content payload (no silent {}, no truncation)", async () => {
    const ctx = makeCtx();
    const db = ctx.db;
    const big = "The quick brown fox jumps over the lazy dog. ".repeat(2400); // >100KB
    const raw = JSON.stringify({ projectId: "qMM4mUBTnZGz", title: "Large", content: big });
    expect(raw.length).toBeGreaterThan(100_000);
    const out = await runRaw(ctx, "ensure_note", raw);
    expect(out.stage).toBe("execute");
    if (out.stage === "execute") {
      expect(out.result.action).toBe("created");
      const note = getNoteById(db, out.result.id as string) as Record<string, unknown>;
      expect((note.content as string).length).toBe(big.length);
      expect(note.content).toBe(big);
    }
  });
});
