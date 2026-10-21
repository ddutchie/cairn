import { describe, expect, it } from "vitest";
import { isAbsolutePath, validateStdioServer, parseClaudeStdioEntry } from "./stdio-validation";

describe("isAbsolutePath", () => {
  it("accepts POSIX and Windows roots", () => {
    expect(isAbsolutePath("/tmp/x")).toBe(true);
    expect(isAbsolutePath("C:\\tools\\mcp.exe")).toBe(true);
    expect(isAbsolutePath("C:/tools/mcp.exe")).toBe(true);
    expect(isAbsolutePath("relative/x")).toBe(false);
  });
});

describe("validateStdioServer", () => {
  it("accepts Windows absolute command and cwd", () => {
    expect(
      validateStdioServer({ command: "C:\\tools\\mcp.exe", args: [], env: {}, cwd: "C:\\work" }).ok,
    ).toBe(true);
  });
  it("rejects shell syntax and .. traversal", () => {
    expect(validateStdioServer({ command: "npx -y" }).ok).toBe(false);
    expect(validateStdioServer({ command: "..\\x" }).ok).toBe(false);
    expect(validateStdioServer({ command: "npx", cwd: "..\\x" }).ok).toBe(false);
  });
  it("keeps spaces inside args (no splitting here)", () => {
    expect(validateStdioServer({ command: "npx", args: ["/Users/me/My Documents"] }).ok).toBe(true);
  });
});

describe("parseClaudeStdioEntry", () => {
  it("keeps spaced args intact", () => {
    expect(parseClaudeStdioEntry("fs", { command: "npx", args: ["--root", "/Users/me/My Documents"] })).toEqual({
      command: "npx",
      args: ["--root", "/Users/me/My Documents"],
      env: {},
    });
  });
});
