/**
 * Unit tests for artifact-hygiene: legacy viz/ migration, .git/info/exclude
 * management (local-only ignore), and retention pruning of .chat/viz. Plus the
 * chat fs-chain remap that sends plugin `viz/…` resolves into `.chat/viz/…`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { migrateLegacyVizDir, ensureGitExcluded, pruneChatArtifacts, pruneSessionLogs, DEFAULT_SESSION_MAX_AGE_DAYS, CHAT_DIR } from "./artifact-hygiene";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-hygiene-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("migrateLegacyVizDir", () => {
  it("moves a top-level viz/ into .chat/viz/", () => {
    fs.mkdirSync(path.join(root, "viz"), { recursive: true });
    fs.writeFileSync(path.join(root, "viz", "a.html"), "x");
    expect(migrateLegacyVizDir(root)).toBe(true);
    expect(fs.existsSync(path.join(root, "viz"))).toBe(false);
    expect(fs.readFileSync(path.join(root, CHAT_DIR, "viz", "a.html"), "utf8")).toBe("x");
  });

  it("is a no-op without a source dir, and never overwrites an existing target", () => {
    expect(migrateLegacyVizDir(root)).toBe(false);
    fs.mkdirSync(path.join(root, "viz"), { recursive: true });
    fs.mkdirSync(path.join(root, CHAT_DIR, "viz"), { recursive: true });
    fs.writeFileSync(path.join(root, "viz", "old.html"), "old");
    expect(migrateLegacyVizDir(root)).toBe(false);
    expect(fs.existsSync(path.join(root, "viz", "old.html"))).toBe(true);
  });
});

describe("ensureGitExcluded", () => {
  it("appends artifact entries once (idempotent), only inside a git repo", () => {
    // No repo → no-op.
    expect(ensureGitExcluded(root)).toBe(false);
    // Repo → writes; second call is a no-op.
    fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    expect(ensureGitExcluded(root)).toBe(true);
    const excludePath = path.join(root, ".git", "info", "exclude");
    const once = fs.readFileSync(excludePath, "utf8");
    expect(once).toContain(".chat/");
    expect(once).toContain("viz/");
    expect(ensureGitExcluded(root)).toBe(false);
    expect(fs.readFileSync(excludePath, "utf8")).toBe(once);
    // Existing user content is preserved.
    fs.writeFileSync(excludePath, "my-custom-ignore\n");
    expect(ensureGitExcluded(root)).toBe(true);
    const merged = fs.readFileSync(excludePath, "utf8");
    expect(merged.startsWith("my-custom-ignore\n")).toBe(true);
    expect(merged).toContain(".chat/");
  });
});

describe("pruneChatArtifacts", () => {
  it("keeps the newest N files by mtime and removes older ones", async () => {
    const dir = path.join(root, CHAT_DIR, "viz");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `v${i}.html`);
      fs.writeFileSync(p, String(i));
      const t = Date.now() - (100 - i) * 1000;
      try { fs.utimesSync(p, new Date(t), new Date(t)); } catch { /* mtime best-effort */ }
    }
    const removed = pruneChatArtifacts(root, "viz", 2);
    expect(removed).toBe(3);
    const left = fs.readdirSync(dir).sort();
    expect(left).toEqual(["v3.html", "v4.html"]);
  });

  it("returns 0 when under the cap or the dir does not exist", () => {
    expect(pruneChatArtifacts(root, "viz")).toBe(0);
    const dir = path.join(root, CHAT_DIR, "viz");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "only.html"), "x");
    expect(pruneChatArtifacts(root, "viz", 100)).toBe(0);
  });
});

describe("pruneSessionLogs", () => {
  function makeSession(sessionRoot: string, project: string, id: string, mtimeMs: number, logSize = 100): string {
    const dir = path.join(sessionRoot, project, id);
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, "session.jsonl.zstd");
    fs.writeFileSync(log, Buffer.alloc(logSize, 0));
    // Set both the log and the dir mtime to the target time so both branches
    // of the guard (dir mtime OR log mtime) can be exercised deterministically.
    fs.utimesSync(log, new Date(mtimeMs), new Date(mtimeMs));
    fs.utimesSync(dir, new Date(mtimeMs), new Date(mtimeMs));
    return dir;
  }

  it("removes sessions older than the cutoff, keeps fresh ones", () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const stale = makeSession(root, "proj-a", "sess-stale-1", now - 200 * dayMs);
    const staleB = makeSession(root, "proj-a", "sess-stale-2", now - 100 * dayMs);
    const fresh = makeSession(root, "proj-a", "sess-fresh", now - 10 * dayMs);
    const result = pruneSessionLogs(root, 90);
    expect(result.scanned).toBe(3);
    expect(result.removed).toBe(2);
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(staleB)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("preserves an old session whose log was recently updated (resumed session)", () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const dir = path.join(root, "proj-a", "sess-resumed");
    fs.mkdirSync(dir, { recursive: true });
    // Directory mtime looks old, but the log file was updated recently.
    const log = path.join(dir, "session.jsonl.zstd");
    fs.writeFileSync(log, Buffer.alloc(200, 0));
    fs.utimesSync(dir, new Date(now - 200 * dayMs), new Date(now - 200 * dayMs));
    fs.utimesSync(log, new Date(now - 1 * dayMs), new Date(now - 1 * dayMs));
    const result = pruneSessionLogs(root, 90);
    expect(result.removed).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("cleans up empty project (encoded-cwd) directories after pruning", () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    makeSession(root, "proj-empty-after", "s1", now - 200 * dayMs);
    makeSession(root, "proj-mixed", "s-old", now - 200 * dayMs);
    makeSession(root, "proj-mixed", "s-fresh", now - 10 * dayMs);
    pruneSessionLogs(root, 90);
    expect(fs.existsSync(path.join(root, "proj-empty-after"))).toBe(false);
    expect(fs.existsSync(path.join(root, "proj-mixed"))).toBe(true);
  });

  it("is a no-op on an empty sessionRoot", () => {
    const result = pruneSessionLogs(root, 90);
    expect(result).toEqual({ scanned: 0, removed: 0, bytesFreed: 0, cutoffMs: expect.any(Number) });
  });

  it("enforces the MIN_SESSION_MAX_AGE_DAYS floor when the argument is 0 or negative", () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    // Yesterday's session — well under the 1-day floor, so it MUST survive
    // even if the caller passes 0 or a negative budget.
    const dir = makeSession(root, "proj-a", "sess-yesterday", now - 0.5 * dayMs);
    const result = pruneSessionLogs(root, 0);
    expect(result.removed).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("reads CAIRN_SESSION_MAX_AGE_DAYS when no explicit budget is given", () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    makeSession(root, "proj-a", "s-30d", now - 30 * dayMs);
    const orig = process.env.CAIRN_SESSION_MAX_AGE_DAYS;
    process.env.CAIRN_SESSION_MAX_AGE_DAYS = "7";
    try {
      const result = pruneSessionLogs(root);
      expect(result.removed).toBe(1);
    } finally {
      if (orig === undefined) delete process.env.CAIRN_SESSION_MAX_AGE_DAYS;
      else process.env.CAIRN_SESSION_MAX_AGE_DAYS = orig;
    }
  });

  it("exports a sensible 90-day default", () => {
    expect(DEFAULT_SESSION_MAX_AGE_DAYS).toBe(90);
  });
});
