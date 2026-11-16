/**
 * proc.test.ts — pin the shared child-process helper (F6/B5) with real short
 * commands, as agent/jobs.test.ts does.
 */
import { describe, expect, it } from "vitest";
import { killTree, platformShell, runProcess, spawnTracked } from "./proc";

const SH = "/bin/sh";

describe("runProcess", () => {
  it("captures stdout/stderr separately with the exit code", async () => {
    const r = await runProcess({ file: SH, args: ["-c", "echo out; echo err >&2; exit 3"] });
    expect(r).toMatchObject({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false, aborted: false, truncated: false });
  });

  it("reports the signal when the child dies from one", async () => {
    const r = await runProcess({ file: SH, args: ["-c", "kill -TERM $$"] });
    expect(r.code).toBeNull();
    expect(r.signal).toBe("SIGTERM");
  });

  it("merges stderr into stdout when combine is set", async () => {
    const r = await runProcess({ file: SH, args: ["-c", "echo out; echo err >&2"], combine: true });
    expect(r.stdout).toContain("out");
    expect(r.stdout).toContain("err");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  it("delivers stdin to the child", async () => {
    const r = await runProcess({ file: SH, args: ["-c", "cat"], stdin: "hello-stdin" });
    expect(r).toMatchObject({ code: 0, stdout: "hello-stdin" });
  });

  it("keeps the tail when output exceeds the cap", async () => {
    const r = await runProcess({ file: SH, args: ["-c", "seq 1 2000"], maxChars: 100, keep: "tail" });
    expect(r.code).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(100);
    expect(r.stdout).toContain("2000");
    expect(r.stdout).not.toContain("\n1\n");
  });

  it("keeps the head and stops the child when the cap is hit with killOnCap", async () => {
    const r = await runProcess({ file: SH, args: ["-c", "while true; do echo hello; done"], maxChars: 100, keep: "head", killOnCap: true });
    expect(r.truncated).toBe(true);
    expect(r.stdout.startsWith("hello")).toBe(true);
  });

  it("reports a spawn failure instead of rejecting", async () => {
    const r = await runProcess({ file: "/nonexistent-cairn-binary-xyz" });
    expect(r.code).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it("resolves already-aborted without spawning", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await runProcess({ file: SH, args: ["-c", "echo hi"], signal: ctl.signal });
    expect(r).toMatchObject({ aborted: true, stdout: "" });
  });

  it("aborts a running child", async () => {
    const ctl = new AbortController();
    const p = runProcess({ file: SH, args: ["-c", "sleep 30; echo done"], signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).not.toContain("done");
  });

  it.runIf(process.platform !== "win32")("times out and kills the whole process group", async () => {
    // The grandchild prints its pid; after the timeout it must be dead, which
    // only a group kill guarantees (killing just `sh` would orphan the sleep).
    const r = await runProcess({ file: SH, args: ["-c", "sleep 60 & echo $!; wait"], timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    const grandchild = Number(r.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    try {
      await new Promise((res) => setTimeout(res, 300));
      expect(() => process.kill(grandchild, 0)).toThrow();
    } finally {
      try { process.kill(grandchild, "SIGKILL"); } catch { /* already dead: the assertion held */ }
    }
  });
});

describe("spawnTracked + killTree", () => {
  it("streams output like a bare spawn", async () => {
    const child = spawnTracked(SH, ["-c", "echo hi"]);
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    const code = await new Promise((resolve) => { child.on("error", () => resolve(-1)); child.on("close", resolve); });
    expect(code).toBe(0);
    expect(out).toBe("hi\n");
  });

  it.runIf(process.platform !== "win32")("killTree stops a sleeping child", async () => {
    const child = spawnTracked(SH, ["-c", "sleep 60"]);
    const pid = await new Promise<number>((resolve, reject) => {
      if (child.pid !== undefined) { resolve(child.pid); return; }
      child.on("spawn", () => child.pid !== undefined ? resolve(child.pid) : reject(new Error("no pid")));
      child.on("error", reject);
    });
    const closed = new Promise((resolve) => { child.on("error", () => resolve(-1)); child.on("close", resolve); });
    killTree(pid);
    await closed;
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("platformShell", () => {
  it("passes the command through to a real shell", async () => {
    const { file, args } = platformShell("echo shell-ok");
    expect(args.at(-1)).toBe("echo shell-ok");
    const r = await runProcess({ file, args });
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout).toContain("shell-ok");
  });
});
