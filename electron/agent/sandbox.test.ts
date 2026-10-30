import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { bwrapArgs, sandboxDenialHint, sandboxStatus, seatbeltProfile, wrapSandboxed, writableRoots } from "./sandbox";
import { decide, type PolicyState } from "./policy";
import { offeredGrants } from "./rules";

describe("sandbox profiles", () => {
  it("seatbelt denies writes outside the roots and quotes paths", () => {
    const p = seatbeltProfile(["/work/a b", '/x"y']);
    expect(p).toContain("(deny file-write*)");
    expect(p).toContain('(subpath "/work/a b")');
    expect(p).toContain('(subpath "/x\\"y")');
    expect(p).not.toContain("(deny network*)");
    expect(seatbeltProfile(["/w"], true)).toContain("(deny network*)");
  });

  it("bwrap mounts root read-only and binds only existing roots", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-"));
    const args = bwrapArgs([dir, "/definitely/missing"], true);
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
    expect(args).toContain(dir);
    expect(args).not.toContain("/definitely/missing");
    expect(args).toContain("--unshare-net");
    fs.rmSync(dir, { recursive: true });
  });

  it("always includes the cwd and temp dirs as writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-"));
    const roots = writableRoots(dir);
    expect(roots).toContain(fs.realpathSync(dir));
    fs.rmSync(dir, { recursive: true });
  });

  it("wrap is a no-op when off or unsupported", () => {
    const cmd = { file: "/bin/bash", args: ["-c", "true"] };
    expect(wrapSandboxed(cmd, "/w", { mode: "off" })).toBe(cmd);
    expect(wrapSandboxed(cmd, "/w", { mode: "workspace-write" }, "win32")).toBe(cmd);
    expect(sandboxStatus("workspace-write", "win32")).toMatchObject({ active: false, backend: "none" });
    expect(sandboxStatus("off")).toMatchObject({ active: false });
  });

  it("hints only on denial-looking output", () => {
    expect(sandboxDenialHint("touch: x: Operation not permitted")).toContain("unsandboxed");
    expect(sandboxDenialHint("all good")).toBeUndefined();
  });

  it.runIf(process.platform === "darwin")("seatbelt confines real writes (macOS)", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-w-"));
    const outside = fs.mkdtempSync(path.join(os.homedir(), ".sbx-out-"));
    try {
      const run = (cmd: string) => {
        const w = wrapSandboxed({ file: "/bin/bash", args: ["-c", cmd] }, work, { mode: "workspace-write" });
        return spawnSync(w.file, w.args, { cwd: work, encoding: "utf8" });
      };
      expect(run("echo hi > inside.txt").status).toBe(0);
      expect(fs.readFileSync(path.join(work, "inside.txt"), "utf8")).toBe("hi\n");
      const denied = run(`echo no > ${outside}/f.txt`);
      expect(denied.status).not.toBe(0);
      expect(fs.existsSync(path.join(outside, "f.txt"))).toBe(false);
      expect(run("cat /etc/hosts >/dev/null").status).toBe(0);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("escalation policy", () => {
  const state = (mode: PolicyState["mode"]): PolicyState => ({ mode, rules: [], deniedTools: [], protectedPaths: [], workspaceRoot: "/w", recent: [], doomAcked: new Set(), now: () => 0 } as unknown as PolicyState);
  const call = { name: "bash", args: {}, risk: { class: "EXEC" as const, command: "ls", escalation: true } };

  it("asks even in yolo and offers no grants", () => {
    expect(decide(call as never, "sig", state("yolo"))).toMatchObject({ kind: "ask" });
    expect(offeredGrants(call.risk)).toEqual([]);
  });
});
