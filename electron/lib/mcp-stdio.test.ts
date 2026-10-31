import { describe, expect, it } from "vitest";
import { parseClaudeStdioEntry, resolveStdioEnv, validateStdioServer } from "./mcp-stdio";

describe("validateStdioServer", () => {
  it("accepts a bare executable with args/env/cwd", () => {
    expect(
      validateStdioServer({ command: "npx", args: ["-y", "pkg"], env: { KEY: "v" }, cwd: "/tmp" }),
    ).toEqual({ ok: true, errors: [] });
  });
  it("rejects shell metacharacters and inline args", () => {
    expect(validateStdioServer({ command: "npx -y pkg" }).ok).toBe(false);
    expect(validateStdioServer({ command: "a;b" }).ok).toBe(false);
  });
  it("rejects relative cwd", () => {
    expect(validateStdioServer({ command: "npx", cwd: "relative" }).ok).toBe(false);
  });
});

describe("parseClaudeStdioEntry", () => {  it("parses a Claude Desktop entry", () => {
    expect(parseClaudeStdioEntry("fs", { command: "npx", args: ["-y", "x"], env: { A: "b" } })).toEqual({
      command: "npx",
      args: ["-y", "x"],
      env: { A: "b" },
    });
  });
  it("throws on missing command", () => {
    expect(() => parseClaudeStdioEntry("fs", {})).toThrow();
  });
});

describe("resolveStdioEnv", () => {
  it("fills in a PATH when none is set", () => {
    const out = resolveStdioEnv({});
    expect(out.PATH).toBeTruthy();
    expect(Object.keys(out).filter((k) => k.toLowerCase() === "path")).toHaveLength(1);
  });

  it("leaves a user-supplied PATH untouched", () => {
    expect(resolveStdioEnv({ PATH: "/custom" }).PATH).toBe("/custom");
  });

  it("canonicalizes a Windows-style Path key to PATH", () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const out = resolveStdioEnv({ Path: "C:\\tools" });
      expect(out.PATH).toBe("C:\\tools");
      expect(out).not.toHaveProperty("Path");
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    }
  });
});
