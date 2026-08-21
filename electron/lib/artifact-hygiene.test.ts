/**
 * Unit tests for artifact-hygiene: legacy viz/ migration, .git/info/exclude
 * management (local-only ignore), and retention pruning of .chat/viz. Plus the
 * chat fs-chain remap that sends plugin `viz/…` resolves into `.chat/viz/…`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { migrateLegacyVizDir, ensureGitExcluded, pruneChatArtifacts, CHAT_DIR } from "./artifact-hygiene";

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
