import { describe, expect, it } from "vitest";
import { parseClaudeStdioEntry, toDshStdioConfig, validateStdioServer } from "./mcp-stdio";

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

describe("toDshStdioConfig", () => {
  it("builds a dsh stdio config", () => {
    const out = toDshStdioConfig({ id: "local", command: "npx", args: ["-y"], env: {}, cwd: "/tmp" });
    expect(out.eligible).toBe(true);
  });
  it("rejects bad server names", () => {
    const out = toDshStdioConfig({ id: "bad name!", command: "npx" });
    expect(out.eligible).toBe(false);
  });
});

describe("parseClaudeStdioEntry", () => {
  it("parses a Claude Desktop entry", () => {
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
