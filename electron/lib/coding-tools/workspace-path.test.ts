import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveContainedPath } from "./workspace-path";

describe("resolveContainedPath", () => {
  let cwd: string;
  let cleanup: (() => void)[];

  const setup = () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-ws-"));
    cleanup = [];
    fs.writeFileSync(path.join(cwd, "file.txt"), "x");
    fs.mkdirSync(path.join(cwd, "sub"));
    fs.writeFileSync(path.join(cwd, "sub", "nested.txt"), "y");
    return cwd;
  };

  afterEach(() => {
    for (const fn of cleanup) fn();
  });

  it("accepts relative paths inside the workspace", () => {
    const base = setup();
    expect(resolveContainedPath(base, "file.txt")).toBe(path.join(base, "file.txt"));
    expect(resolveContainedPath(base, "sub/nested.txt")).toBe(path.join(base, "sub/nested.txt"));
    expect(resolveContainedPath(base, undefined)).toBe(base); // omitted → cwd itself
    expect(resolveContainedPath(base, ".")).toBe(base);
  });

  it("accepts absolute paths that resolve inside the workspace", () => {
    const base = setup();
    expect(resolveContainedPath(base, path.join(base, "sub", "nested.txt"))).toBe(path.join(base, "sub", "nested.txt"));
  });

  it("rejects absolute paths outside the workspace", () => {
    const base = setup();
    expect(resolveContainedPath(base, "/etc/passwd")).toBeNull();
    expect(resolveContainedPath(base, os.tmpdir())).toBeNull();
  });

  it("rejects parent traversal that escapes the workspace", () => {
    const base = setup();
    expect(resolveContainedPath(base, "../escape.txt")).toBeNull();
    expect(resolveContainedPath(base, "sub/../../escape.txt")).toBeNull();
  });

  it("allows parent traversal that stays inside the workspace", () => {
    const base = setup();
    expect(resolveContainedPath(base, "sub/../file.txt")).toBe(path.join(base, "file.txt"));
  });

  it("rejects a symlink inside the workspace that points outside it", () => {
    const base = setup();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-outside-"));
    fs.symlinkSync(outsideDir, path.join(base, "escaped-link"));
    cleanup.push(() => { try { fs.unlinkSync(path.join(base, "escaped-link")); } catch { /* already gone */ } });
    expect(resolveContainedPath(base, "escaped-link")).toBeNull();
  });

  it("allows a symlink that resolves inside the workspace", () => {
    const base = setup();
    fs.symlinkSync(path.join(base, "sub"), path.join(base, "link-to-sub"));
    cleanup.push(() => { try { fs.unlinkSync(path.join(base, "link-to-sub")); } catch { /* already gone */ } });
    expect(resolveContainedPath(base, "link-to-sub/nested.txt")).toBe(path.join(base, "link-to-sub/nested.txt"));
  });

  it("passes a missing path so the caller reports 'not found'", () => {
    const base = setup();
    expect(resolveContainedPath(base, "missing.txt")).toBe(path.join(base, "missing.txt"));
  });
});
