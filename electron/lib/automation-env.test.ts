/**
 * Automation env resolution + materialization (phase 3).
 *
 * Non-secret env vars are stored inline and materialized to the folder's .env;
 * secret vars resolve via an injected resolver (the keychain in the runner) and
 * are NEVER written to disk.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { isValidEnvName, materializeEnvFile, quoteEnvValue, resolveAutomationEnv, writeAutomationManifest } from "./automation-env";
import type { Automation } from "../db/automation-queries";

function makeAutomation(env: Automation["env"]): Automation {
  return {
    id: "aut-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    name: "Image brief",
    description: "",
    instructions: "Make images",
    scheduleKind: "every",
    scheduleExpr: "1 hour",
    timezone: null,
    nextRunAt: new Date().toISOString(),
    enabled: true,
    maxRuns: null,
    runCount: 0,
    approvalMode: "auto",
    activeHoursStart: null,
    activeHoursEnd: null,
    standingRules: [],
    requires: [],
    env,
    source: "custom",
    communityId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "automation-env-"));
}

describe("resolveAutomationEnv", () => {
  it("merges inline non-secrets with keychain-resolved secrets", () => {
    const a = makeAutomation([
      { name: "PLAIN", value: "abc", secret: false },
      { name: "SECRET", secret: true },
      { name: "EMPTY_PLAIN", value: "", secret: false },
      { name: "EMPTY_SECRET", secret: true },
    ]);
    const resolved = resolveAutomationEnv(a, (name) => (name === "SECRET" ? "s3cret" : name === "EMPTY_SECRET" ? null : null));
    expect(resolved.PLAIN).toBe("abc");
    expect(resolved.SECRET).toBe("s3cret");
    expect(resolved.EMPTY_PLAIN).toBeUndefined();
    expect(resolved.EMPTY_SECRET).toBeUndefined();
  });

  it("omits secrets whose resolver returns null or empty (missing keychain value)", () => {
    const a = makeAutomation([{ name: "KEY", secret: true }]);
    expect(resolveAutomationEnv(a, () => null)).toEqual({});
    expect(resolveAutomationEnv(a, () => "")).toEqual({});
  });
});

describe("isValidEnvName / quoteEnvValue", () => {
  it("accepts shell-safe env var names only", () => {
    expect(isValidEnvName("IMG_API_KEY")).toBe(true);
    expect(isValidEnvName("_SECRET")).toBe(true);
    expect(isValidEnvName("a1_b2")).toBe(true);
    expect(isValidEnvName("1ABC")).toBe(false);
    expect(isValidEnvName("with space")).toBe(false);
    expect(isValidEnvName("a-b")).toBe(false);
    expect(isValidEnvName("")).toBe(false);
  });

  it("quotes env values for .env / shell source-ing", () => {
    expect(quoteEnvValue("plain")).toBe('"plain"');
    expect(quoteEnvValue("with space")).toBe('"with space"');
    expect(quoteEnvValue('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe("materializeEnvFile", () => {
  it("writes non-secrets only and never secrets", () => {
    const dir = tmpDir();
    const a = makeAutomation([
      { name: "PLAIN", value: "hello world", secret: false },
      { name: "API_KEY", value: "", secret: false },
      { name: "SECRET", secret: true },
    ]);
    materializeEnvFile(dir, a);
    const content = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(content).toContain('PLAIN="hello world"');
    expect(content).not.toContain("SECRET");
    expect(content).not.toContain("API_KEY"); // empty value → omitted
  });

  it("leaves an empty .env when there is nothing to write", () => {
    const dir = tmpDir();
    materializeEnvFile(dir, makeAutomation([]));
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe("");
  });
});

describe("writeAutomationManifest", () => {
  it("writes a minimal manifest with env schema + requires", () => {
    const dir = tmpDir();
    const a = makeAutomation([
      { name: "PLAIN", value: "abc", secret: false },
      { name: "SECRET", secret: true },
    ]);
    a.requires = [{ kind: "mcp", name: "browser" }];
    writeAutomationManifest(dir, a);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(manifest.name).toBe("Image brief");
    expect(manifest.env).toEqual([
      { name: "PLAIN", secret: false },
      { name: "SECRET", secret: true },
    ]);
    expect(manifest.requires).toEqual([{ kind: "mcp", name: "browser" }]);
  });

  it("never overwrites an existing (agent-authored) manifest", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "manifest.json"), '{"name":"custom","entry":"scripts/x.js"}', "utf8");
    writeAutomationManifest(dir, makeAutomation([{ name: "A", value: "1", secret: false }]));
    expect(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).name).toBe("custom");
  });
});
