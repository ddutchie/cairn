/**
 * Automation folder plumbing — path derivation + per-run folder lifecycle.
 *
 * Phase 1 of the automation "mini-app" work: every run gets a working folder
 * under <project>/.automations/<automationId>/runs/<runId>/, dot-prefixed so the
 * notes browser / file-watcher / Obsidian all ignore it. Old run folders are
 * pruned keeping the newest N.
 */

import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  automationFolderDir,
  automationRunDir,
  automationScriptsDir,
  cleanupOldRunDirs,
  ensureAutomationRunDir,
  listAutomationFolderFiles,
  projectRootDir,
  readRunLog,
  writeRunLog,
} from "./automation-folder";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "automation-folder-"));
}

describe("automation folder paths", () => {
  it("resolves the project root as a slugged folder under the workspace", () => {
    expect(projectRootDir("/ws", "Research / Docs")).toBe(path.join("/ws", "Research Docs"));
  });

  it("resolves the automation folder under the project root (project-scoped)", () => {
    const dir = automationFolderDir("/ws", "aut-1", "My Project");
    expect(dir).toBe(path.join("/ws", "My Project", ".automations", "aut-1"));
  });

  it("resolves the automation folder at the workspace root when there is no project", () => {
    const dir = automationFolderDir("/ws", "aut-1", null);
    expect(dir).toBe(path.join("/ws", ".automations", "aut-1"));
  });

  it("resolves the scripts and per-run folders inside the automation folder", () => {
    const auto = "/ws/P/.automations/aut-1";
    expect(automationScriptsDir(auto)).toBe(path.join(auto, "scripts"));
    expect(automationRunDir(auto, "run-9")).toBe(path.join(auto, "runs", "run-9"));
  });
});

describe("automation folder fs operations", () => {
  it("creates the run dir recursively", () => {
    const root = tmpRoot();
    const auto = automationFolderDir(root, "aut-1", "P");
    const runDir = ensureAutomationRunDir(auto, "run-1");
    expect(fs.existsSync(runDir)).toBe(true);
    expect(automationRunDir(auto, "run-1")).toBe(runDir);
  });

  it("keeps the newest run dirs and prunes the oldest, leaving loose files untouched", () => {
    const root = tmpRoot();
    const auto = automationFolderDir(root, "aut-1", "P");
    const runsDir = path.join(auto, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    // Loose files in runs/ that must survive pruning.
    fs.writeFileSync(path.join(runsDir, "keep.json"), "{}");
    fs.writeFileSync(path.join(runsDir, "notes.md"), "# x");
    // Nine run dirs with ascending mtimes.
    for (let i = 1; i <= 9; i++) {
      const d = path.join(runsDir, `run-${i}`);
      fs.mkdirSync(d, { recursive: true });
      const t = new Date(Date.UTC(2026, 0, i, 0, 0, 0));
      fs.utimesSync(d, t, t);
    }

    const removed = cleanupOldRunDirs(auto, 3);

    expect(removed).toBe(6); // 9 dirs − 3 kept
    const remaining = fs.readdirSync(runsDir).filter((e) => fs.statSync(path.join(runsDir, e)).isDirectory());
    expect(remaining).toEqual(["run-7", "run-8", "run-9"]);
    expect(fs.existsSync(path.join(runsDir, "keep.json"))).toBe(true);
    expect(fs.existsSync(path.join(runsDir, "notes.md"))).toBe(true);
  });

  it("returns 0 when runs/ does not exist", () => {
    const root = tmpRoot();
    expect(cleanupOldRunDirs(path.join(root, "nope"), 3)).toBe(0);
  });
});

describe("run-log transcript (atomic write)", () => {
  const baseLog = {
    automationId: "aut-1",
    runId: "run-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "done",
    tools: [{ name: "run_script" }],
    tokens: "summary",
  };

  it("round-trips a written transcript through readRunLog", () => {
    const root = tmpRoot();
    const runDir = path.join(root, "run-1");
    fs.mkdirSync(runDir, { recursive: true });
    writeRunLog(runDir, baseLog);
    const log = readRunLog(runDir);
    expect(log?.status).toBe("done");
    expect(log?.tools).toEqual([{ name: "run_script" }]);
  });

  it("readRunLog never consumes a partial transcript from an interrupted write", () => {
    const root = tmpRoot();
    const runDir = path.join(root, "run-1");
    fs.mkdirSync(runDir, { recursive: true });
    writeRunLog(runDir, baseLog);

    // Simulate a crash mid-write under a naive implementation: a partial write
    // landing directly on the final path. The atomic writer must have left the
    // previous complete transcript intact and never expose the garbage.
    fs.writeFileSync(path.join(runDir, ".run-log.json.tmp"), "{broken");
    const log = readRunLog(runDir);
    expect(log?.status).toBe("done");

    // The next write recovers: tmp is overwritten, final is replaced atomically.
    writeRunLog(runDir, { ...baseLog, status: "exhausted" });
    expect(readRunLog(runDir)?.status).toBe("exhausted");
    expect(fs.readFileSync(path.join(runDir, "run-log.json"), "utf8")).toContain('"exhausted"');
  });

  it("a failed rename leaves the previously seeded transcript readable and unchanged", () => {
    const root = tmpRoot();
    const runDir = path.join(root, "run-1");
    fs.mkdirSync(runDir, { recursive: true });
    writeRunLog(runDir, baseLog);

    // Inject a failure at the rename step: the temp file has been fully written
    // and fsynced but the atomic swap throws. The seeded run-log.json must
    // survive exactly as it was — a failed write never corrupts the final path.
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("EIO: simulated rename failure");
    });
    writeRunLog(runDir, { ...baseLog, status: "exhausted" });
    renameSpy.mockRestore();

    expect(readRunLog(runDir)?.status).toBe("done"); // unchanged
    expect(fs.readFileSync(path.join(runDir, "run-log.json"), "utf8")).toContain('"done"');

    // Recovery: a subsequent successful write replaces the transcript normally.
    writeRunLog(runDir, { ...baseLog, status: "exhausted" });
    expect(readRunLog(runDir)?.status).toBe("exhausted");
  });

  it("readRunLog returns null when the run folder is empty", () => {
    const root = tmpRoot();
    const runDir = path.join(root, "run-1");
    fs.mkdirSync(runDir, { recursive: true });
    expect(readRunLog(runDir)).toBeNull();
  });
});

describe("automation folder file listing", () => {
  it("lists files recursively and skips per-run scratch (runs/)", () => {
    const root = tmpRoot();
    const auto = automationFolderDir(root, "aut-1", "P");
    fs.mkdirSync(path.join(auto, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(auto, "runs", "run-1"), { recursive: true });
    fs.writeFileSync(path.join(auto, "manifest.json"), "{}");
    fs.writeFileSync(path.join(auto, ".env"), "A=1\n");
    fs.writeFileSync(path.join(auto, "scripts", "gen.js"), "console.log(1)");
    fs.writeFileSync(path.join(auto, "runs", "run-1", "out.png"), "data");

    const files = listAutomationFolderFiles(auto);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([".env", "manifest.json", "scripts/gen.js"]);
    const gen = files.find((f) => f.path === "scripts/gen.js")!;
    expect(gen.size).toBeGreaterThan(0);
    expect(gen.mtimeMs).toBeGreaterThan(0);
  });
});
