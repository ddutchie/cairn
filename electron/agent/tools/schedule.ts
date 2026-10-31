/** schedule_create / schedule_list / schedule_cancel: reminders that prompt this session later. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import type { ScheduleEntry } from "../events";
import { fail, ok } from "./schema";

export interface ScheduleDeps {
  list(): ScheduleEntry[];
  add(prompt: string, at: Date, kind: ScheduleEntry["kind"]): Promise<ScheduleEntry>;
  cancel(id: string): Promise<boolean>;
}

const MAX_DELAY_MS = 30 * 24 * 3_600_000;

export function scheduleTools(deps: ScheduleDeps): AgentTool[] {
  const read = () => ({ class: "READ" as const });
  return [
    defineTool({
      name: "schedule_create",
      description: "Remind yourself later: when the time comes this session is prompted with `prompt`. Give either afterMinutes or at (an ISO datetime).",
      parameters: Type.Object({
        prompt: Type.String({ description: "What to do when the reminder fires." }),
        afterMinutes: Type.Optional(Type.Number()),
        at: Type.Optional(Type.String({ description: "ISO 8601 datetime." })),
      }),
      risk: read,
      async execute(a) {
        const now = Date.now();
        const when = a.at ? Date.parse(a.at) : a.afterMinutes !== undefined ? now + a.afterMinutes * 60_000 : NaN;
        if (!a.prompt.trim()) return fail("prompt must not be empty");
        if (!Number.isFinite(when)) return fail("Give afterMinutes or a valid ISO datetime in at.");
        if (when - now > MAX_DELAY_MS) return fail("Reminders can be at most 30 days out.");
        const entry = await deps.add(a.prompt.trim(), new Date(Math.max(when, now)), a.at ? "at" : "after");
        return ok(`Scheduled ${entry.id} for ${entry.at}.`);
      },
    }),
    defineTool({
      name: "schedule_list",
      description: "List this session's pending reminders.",
      parameters: Type.Object({}),
      risk: read,
      async execute() {
        const list = deps.list();
        return ok(list.length ? list.map((s) => `${s.id}  ${s.at}  ${s.prompt}`).join("\n") : "No reminders.");
      },
    }),
    defineTool({
      name: "schedule_cancel",
      description: "Cancel a pending reminder by id.",
      parameters: Type.Object({ id: Type.String() }),
      risk: read,
      async execute(a) {
        return (await deps.cancel(a.id)) ? ok(`Cancelled ${a.id}.`) : fail(`No pending reminder ${a.id}.`);
      },
    }),
  ];
}
