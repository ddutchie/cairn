import { describe, expect, it } from "vitest";
import { JobRegistry } from "./jobs";

const until = async (cond: () => boolean) => { for (const end = Date.now() + 5_000; !cond() && Date.now() < end;) await new Promise((r) => setTimeout(r, 20)); };

function make() {
  const settled: Array<{ id: string; status: string; tail: string }> = [];
  const changes: string[] = [];
  const registry = new JobRegistry({ changed: (o) => changes.push(o), settled: (j, tail) => settled.push({ id: j.id, status: j.status, tail }) });
  return { registry, settled, changes };
}
const sh = (cmd: string) => ({ owner: "s1", label: cmd, file: "/bin/sh", args: ["-c", cmd], cwd: process.cwd() });

describe("JobRegistry", () => {
  it("runs a job to completion and reports its output once", async () => {
    const t = make();
    const job = t.registry.start(sh("echo hi"));
    expect(job.status).toBe("running");
    await until(() => t.settled.length === 1);
    expect(t.settled[0]).toMatchObject({ id: job.id, status: "completed", tail: "hi" });
    expect(t.registry.output(job.id, "s1")?.text).toContain("hi");
    expect(t.registry.list("s1")[0].status).toBe("completed");
  });

  it("marks a non-zero exit as failed", async () => {
    const t = make();
    t.registry.start(sh("exit 3"));
    await until(() => t.settled.length === 1);
    expect(t.settled[0].status).toBe("failed");
  });

  it("kills only for the owner and ends as killed", async () => {
    const t = make();
    const job = t.registry.start(sh("sleep 30"));
    expect(t.registry.kill(job.id, "other")).toBe(false);
    expect(t.registry.output(job.id, "other")).toBeUndefined();
    expect(t.registry.kill(job.id, "s1")).toBe(true);
    await until(() => t.settled.length === 1);
    expect(t.settled[0].status).toBe("killed");
    expect(t.registry.kill(job.id, "s1")).toBe(false);
  });
});
