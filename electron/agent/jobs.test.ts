import { describe, expect, it } from "vitest";
import { JobRegistry } from "./jobs";
import { until } from "./test-harness";

function make() {
  const settled: Array<{ id: string; status: string; tail: string }> = [];
  const changes: string[] = [];
  const registry = new JobRegistry({ changed: (o) => changes.push(o), settled: (j, tail) => settled.push({ id: j.id, status: j.status, tail }) });
  return { registry, settled, changes };
}
// Node scripts, not /bin/sh, so the jobs run on Windows too.
const sh = (js: string) => ({ owner: "s1", label: js, file: process.execPath, args: ["-e", js], cwd: process.cwd() });

describe("JobRegistry", () => {
  it("runs a job to completion and reports its output once", async () => {
    const t = make();
    const job = t.registry.start(sh(`console.log("hi")`));
    expect(job.status).toBe("running");
    await until(() => t.settled.length === 1);
    expect(t.settled[0]).toMatchObject({ id: job.id, status: "completed", tail: "hi" });
    expect(t.registry.output(job.id, "s1")?.text).toContain("hi");
    expect(t.registry.list("s1")[0].status).toBe("completed");
  });

  it("marks a non-zero exit as failed", async () => {
    const t = make();
    t.registry.start(sh("process.exit(3)"));
    await until(() => t.settled.length === 1);
    expect(t.settled[0].status).toBe("failed");
  });

  it("kills only for the owner and ends as killed", async () => {
    const t = make();
    const job = t.registry.start(sh("setTimeout(() => {}, 30000)"));
    expect(t.registry.kill(job.id, "other")).toBe(false);
    expect(t.registry.output(job.id, "other")).toBeUndefined();
    expect(t.registry.kill(job.id, "s1")).toBe(true);
    await until(() => t.settled.length === 1);
    expect(t.settled[0].status).toBe("killed");
    expect(t.registry.kill(job.id, "s1")).toBe(false);
  });
});
