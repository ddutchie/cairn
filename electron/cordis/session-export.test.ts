/**
 * session-export tests — Cairn's `/export` host over dsh-session-log-export.
 *
 * Proves (no live model, no renderer):
 *  - mount: the cairn:session-export plugin registers the global `export`
 *    command on the commands runtime (which is what cordis:listCommands
 *    merges into the palette);
 *  - happy path: exportSessionLog with a fixture session writes a real ZIP
 *    to a tmpdir (PK magic, dsh-session-<id>.zip name, session.jsonl entry);
 *  - fail-closed: unknown session and missing services reject with clean
 *    errors — no empty file, no hang;
 *  - command level: /export through commands.execute fail-softs when the
 *    export services are absent (the real handler path, fixture-free).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import {
  apply as sessionExportApply,
  inject as sessionExportInject,
  name as sessionExportName,
  exportSessionLog,
} from "./session-export";

const SESSION_ID = "test-session-export-1";

// Minimal verbatim JSONL artifact: header line + two events. The export ships
// these bytes untouched (the backend's own serialization, not a rebuild).
const fixtureArtifact = [
  JSON.stringify({ type: "session", version: 0, id: SESSION_ID, createdAt: "2026-09-03T00:00:00.000Z", cwd: "/tmp", delegationDepth: 0 }),
  JSON.stringify({ type: "user/message", seq: 0, data: { message: { content: [{ type: "text", text: "hello export" }] } } }),
  JSON.stringify({ type: "assistant/message", seq: 1, data: { message: { content: [{ type: "text", text: "export fixture reply" }] } } }),
].join("\n").concat("\n");

/** Raw-artifact persistence stub with exactly one fixture session. */
function stubPersistence() {
  return {
    supportsRawArtifacts: true,
    readRaw: async (id: unknown) => {
      if (String(id) !== SESSION_ID) return undefined;
      return { filename: "session.jsonl", content: fixtureArtifact };
    },
  };
}

/** Export deps stub: only persistence serves (root-only export, no media). */
function stubDeps() {
  return {
    sessionQuery: { traceSession: async () => { throw new Error("traceSession must not run for a root-only export"); } },
    sessionPersistence: stubPersistence(),
    attachments: { readImage: async () => { throw new Error("readImage must not run with no image refs"); } },
    sessions: undefined,
  };
}

describe("session-export command registration", () => {
  it("registers the global /export command", async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(CommandRuntime);
      await ctx.plugin(
        { apply: sessionExportApply, inject: sessionExportInject, name: sessionExportName } as never,
        {} as never,
      );
      const found = ctx.commands.find({} as never, "export");
      expect(found).toBeDefined();
      expect(found?.description).toContain("ZIP");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("/export fail-softs through commands.execute when services are absent", async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(CommandRuntime);
      await ctx.plugin(
        { apply: sessionExportApply, inject: sessionExportInject, name: sessionExportName } as never,
        {} as never,
      );
      const agent = {
        session: { header: { id: "no-such-session" }, append: () => {} },
      };
      const out = await ctx.commands.execute(agent as never, "/export", [], new AbortController().signal);
      expect(out?.result.kind).toBe("error");
      expect(out?.result.text).toMatch(/unavailable|not mounted|failed/i);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

describe("exportSessionLog with a fixture session", () => {
  it("streams a real ZIP to the sink dir (nothing retained in memory)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-export-test-"));
    try {
      const { path: filePath, bytes } = await exportSessionLog(
        stubDeps() as never,
        SESSION_ID,
        dir,
      );
      expect(path.basename(filePath)).toBe(`dsh-session-${SESSION_ID}.zip`);
      expect(bytes).toBeGreaterThan(0);
      const raw = fs.readFileSync(filePath);
      // ZIP local-file-header magic.
      expect(raw[0]).toBe(0x50);
      expect(raw[1]).toBe(0x4b);
      // Entry names are stored plaintext: the root log is in the archive.
      expect(raw.includes(Buffer.from("session.jsonl", "utf8"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects cleanly for an unknown session (no file written)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-export-test-"));
    try {
      await expect(exportSessionLog(stubDeps() as never, "missing-session", dir)).rejects.toThrow(/not found/i);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects cleanly when export services are missing", async () => {
    await expect(exportSessionLog(
      { sessionQuery: undefined, sessionPersistence: undefined, attachments: undefined, sessions: undefined },
      SESSION_ID,
      "/tmp/must-not-exist-cairn-export",
    )).rejects.toThrow(/unavailable/i);
  });
});
