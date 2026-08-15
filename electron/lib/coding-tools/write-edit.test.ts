import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { writeTool } from "./write";
import { editTool } from "./edit";

/**
 * The write/edit tools must honour the same containment contract as the read
 * tools: everything lands inside the working directory (the automation folder
 * for a Develop session), never an absolute path or `..` traversal outside it.
 */
describe("coding write/edit containment", () => {
  let cwd: string;
  let outside: string;
  let cleanup: (() => void)[];

  const setup = () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-write-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-outside-"));
    cleanup = [];
    return cwd;
  };

  afterEach(() => {
    for (const fn of cleanup) fn();
  });

  it("writeTool writes a relative path inside cwd", async () => {
    setup();
    await writeTool({ path: "scripts/x.js", content: "// hi" }, cwd);
    expect(fs.readFileSync(path.join(cwd, "scripts", "x.js"), "utf8")).toBe("// hi");
  });

  it("writeTool rejects absolute paths outside cwd", async () => {
    setup();
    await expect(writeTool({ path: path.join(outside, "evil.txt"), content: "boom" }, cwd)).rejects.toThrow(/escapes/);
    expect(fs.existsSync(path.join(outside, "evil.txt"))).toBe(false);
  });

  it("writeTool rejects parent traversal", async () => {
    setup();
    await expect(writeTool({ path: "../escape.txt", content: "boom" }, cwd)).rejects.toThrow(/escapes/);
    expect(fs.existsSync(path.join(cwd, "..", "escape.txt"))).toBe(false);
  });

  it("editTool applies edits inside cwd and rejects escapes", async () => {
    setup();
    fs.writeFileSync(path.join(cwd, "f.txt"), "hello\n");
    await editTool({ path: "f.txt", edits: [{ oldText: "hello", newText: "world" }] }, cwd);
    expect(fs.readFileSync(path.join(cwd, "f.txt"), "utf8")).toBe("world\n");
    await expect(
      editTool({ path: path.join(outside, "g.txt"), edits: [{ oldText: "a", newText: "b" }] }, cwd),
    ).rejects.toThrow(/escapes/);
    await expect(
      editTool({ path: "../g.txt", edits: [{ oldText: "a", newText: "b" }] }, cwd),
    ).rejects.toThrow(/escapes/);
  });
});
