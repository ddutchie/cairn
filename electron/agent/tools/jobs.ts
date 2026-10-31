/** job_output / job_kill: look in on and stop background shell jobs. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import type { JobRegistry } from "../jobs";
import { fail, ok } from "./schema";

export interface JobToolDeps { registry: JobRegistry; owner: string }

export function jobTools({ registry, owner }: JobToolDeps): AgentTool[] {
  return [
    defineTool({
      name: "job_output",
      description: "Status and the latest output of a background bash job started with run_in_background.",
      parameters: Type.Object({ id: Type.String(), tailChars: Type.Optional(Type.Number({ description: "How much trailing output to return (default 4000)." })) }),
      risk: () => ({ class: "READ" }),
      async execute(a) {
        const r = registry.output(a.id, owner, a.tailChars);
        if (!r) return fail(`No job ${a.id} in this session.`);
        return ok(`[${r.summary.status}${r.summary.detail ? `: ${r.summary.detail}` : ""}]\n${r.text || "(no output yet)"}`);
      },
    }),
    defineTool({
      name: "job_kill",
      description: "Stop a running background bash job.",
      parameters: Type.Object({ id: Type.String() }),
      risk: () => ({ class: "READ" }),
      async execute(a) {
        return registry.kill(a.id, owner) ? ok(`Stopping ${a.id}.`) : fail(`Job ${a.id} is not running in this session.`);
      },
    }),
  ];
}
