/**
 * run_script — named-script resolution + cross-platform execution.
 *
 * Phase 2 of the automation "mini-app" work: automations can execute a named,
 * pre-registered script from their scripts/ folder with the run's working dir
 * as cwd. Only a script NAME is accepted (no paths / traversal), args are an
 * array (no shell injection), and output is captured with a timeout + cap.
 */

import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveScript, runAutomationScript, scriptEnv, type AutomationScriptContext } from "./automation-script";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "automation-script-"));
}

function writeScript(dir: string, name: string, content: string): string {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, content, "utf8");
  return fp;
}

function baseCtx(dir: string, overrides: Partial<AutomationScriptContext> = {}): AutomationScriptContext {
  return {
    scriptsDir: dir,
    cwd: dir,
    outDir: path.join(dir, "out"),
    ...overrides,
  };
}

describe("resolveScript", () => {
  it("resolves a .js script to the node runtime", () => {
    const dir = tmpDir();
    writeScript(dir, "gen.js", "");
    const s = resolveScript(dir, "gen");
    expect(s.kind).toBe("node");
    expect(s.file).toBe(path.join(dir, "gen.js"));
  });

  it("resolves .ts, .sh, .py and extensionless candidates to their runtimes", () => {
    const dir = tmpDir();
    writeScript(dir, "a.ts", "");
    writeScript(dir, "b.sh", "#!/bin/bash");
    writeScript(dir, "c.py", "");
    writeScript(dir, "d", "#!/bin/sh");
    expect(resolveScript(dir, "a").kind).toBe("node-ts");
    expect(resolveScript(dir, "b").kind).toBe("bash");
    expect(resolveScript(dir, "c").kind).toBe("python");
    expect(resolveScript(dir, "d").kind).toBe("direct");
  });

  it("rejects unsafe names (path traversal / shell chars)", () => {
    const dir = tmpDir();
    for (const bad of ["../escape", "../../etc", "a/b", "a;b", "x y", "a b"]) {
      expect(() => resolveScript(dir, bad)).toThrow(/Invalid script name/);
    }
  });

  it("throws a helpful not-found error listing the searched candidates", () => {
    const dir = tmpDir();
    try {
      resolveScript(dir, "missing");
      throw new Error("expected throw");
    } catch (err) {
      expect(String(err)).toContain("missing");
      expect(String(err)).toContain("missing.js");
      expect(String(err)).toContain("missing.sh");
    }
  });

  it("throws on ambiguity when multiple candidates exist", () => {
    const dir = tmpDir();
    writeScript(dir, "gen.js", "");
    writeScript(dir, "gen.sh", "#!/bin/bash");
    expect(() => resolveScript(dir, "gen")).toThrow(/Ambiguous/);
  });
});

describe("runAutomationScript", () => {
  it("runs a .js script with cwd, args and CAIRN_* env, returning its stdout", async () => {
    const dir = tmpDir();
    const outDir = path.join(dir, "out");
    writeScript(dir, "probe.js", [
      "const fs = require('fs');",
      "console.log('cwd=' + process.cwd());",
      "console.log('args=' + process.argv.slice(2).join('|'));",
      "console.log('out=' + process.env.CAIRN_OUT_DIR);",
      "console.log('run=' + process.env.CAIRN_RUN_ID);",
    ].join("\n"));

    const output = await runAutomationScript(
      { name: "probe", args: ["-prompt", "news results"] },
      baseCtx(dir, {
        cwd: dir,
        outDir,
        env: { CAIRN_RUN_ID: "run-123" },
      }),
    );

    expect(output).toContain(`cwd=${fs.realpathSync(dir)}`);
    expect(output).toContain("args=-prompt|news results");
    expect(output).toContain(`out=${outDir}`);
    expect(output).toContain("run=run-123");
  });

  it("rejects on non-zero exit code with the captured output", async () => {
    const dir = tmpDir();
    writeScript(dir, "boom.js", "console.log('before failing'); process.exit(3);");
    await expect(runAutomationScript({ name: "boom" }, baseCtx(dir)))
      .rejects.toThrow(/exited with code 3/);
  });

  it("times out and kills the process", async () => {
    const dir = tmpDir();
    writeScript(dir, "slow.js", "setTimeout(() => {}, 5000);");
    await expect(runAutomationScript({ name: "slow", timeout: 0.25 }, baseCtx(dir)))
      .rejects.toThrow(/timed out after/);
  }, 15_000);

  it("rejects when the script does not exist", async () => {
    const dir = tmpDir();
    await expect(runAutomationScript({ name: "nope" }, baseCtx(dir)))
      .rejects.toThrow(/not found/);
  });

  it("surfaces an abort as a rejection", async () => {
    const dir = tmpDir();
    writeScript(dir, "slow.js", "setTimeout(() => {}, 5000);");
    const ctrl = new AbortController();
    const promise = runAutomationScript({ name: "slow" }, baseCtx(dir, { signal: ctrl.signal }));
    setTimeout(() => ctrl.abort(), 50);
    await expect(promise).rejects.toThrow(/aborted/);
  }, 15_000);

  it("builds the CAIRN_* env surface from the context", () => {
    const env = scriptEnv(baseCtx("/s", { cwd: "/s/runs/run-1", env: { CAIRN_RUN_ID: "run-1" } }));
    expect(env.CAIRN_SCRIPTS_DIR).toBe("/s");
    expect(env.CAIRN_SCRATCH_DIR).toBe("/s/runs/run-1");
    expect(env.CAIRN_OUT_DIR).toBe(path.join("/s", "out"));
    expect(env.CAIRN_RUN_ID).toBe("run-1");
  });

  it("is invoked with the provided onUpdate stream", async () => {
    const dir = tmpDir();
    writeScript(dir, "talk.js", "console.log('hello'); console.log('world');");
    const onUpdate = vi.fn();
    await runAutomationScript({ name: "talk" }, baseCtx(dir, { onUpdate }));
    expect(onUpdate).toHaveBeenCalled();
    expect(onUpdate.mock.calls.some(([o]) => String(o).includes("hello"))).toBe(true);
  });
});
