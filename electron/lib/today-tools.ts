/**
 * The tools a Today run builds its brief with. They write only the brief file
 * (`out/today/<date>.json` in the Today automation's folder), so the read-only
 * gate lets them through. Each call saves and calls `onChange`, which tells
 * the renderer to reload: the view fills in while the run is still gathering.
 */

import { defineTool, fromJsonSchema, type AgentTool } from "../agent/index";
import type { TodayBrief } from "../../shared/today/brief";
import { TODAY_LANES, briefOutline, finishBrief, removeItems, upsertItems } from "../../shared/today/brief-edit";

export const TODAY_TOOL_NAMES = ["today_read", "today_upsert", "today_remove", "today_finish"] as const;

export function isTodayBriefTool(name: string): boolean {
  return (TODAY_TOOL_NAMES as readonly string[]).includes(name);
}

export interface TodayBriefSession {
  /** The brief as it stands; tools edit it in place. */
  brief: TodayBrief;
  /** True once `today_finish` ran. */
  finished: boolean;
  /** Why the last save failed; cleared by the next save that works. */
  saveError?: string;
}

function itemSchema(people: boolean) {
  const schema = {
  type: "object",
  properties: {
    lane: { type: "string", enum: [...TODAY_LANES], description: "decision: the user has to choose (give choices). todo: an action to take, no choice. draft: text you wrote for the user to send. fyi: progress worth knowing, no action. event: a meeting today." },
    id: { type: "string", description: "Stable id built from where the item came from, e.g. \"slack-C08AB-1712345.67\", \"jira-CAIRN-212\", \"card-<cardId>\", \"mail-<messageId>\". Reuse it to update an item; a refresh later today keeps the user's done and dismissed state by id. Optional for events." + (people ? " An event with attendees needs the calendar's own event id here, or it is not linked to people." : "") },
    projectId: { type: "string", description: "The Cairn project this belongs to (ids are in the project facts), when it clearly belongs to one." },
    question: { type: "string", description: "decision/todo: the question (yes/no or either/or) or the action, verb first." },
    body: { type: "string", description: "decision/todo: at most 30 words of context." },
    why: { type: "string", description: "decision/todo: one sentence on why it ranks here." },
    priority: { type: "string", enum: ["high", "normal", "low"], description: "decision/todo: high (due today, overdue, or someone is waiting on the user), normal, or low (can wait this week). The brief lists high first and folds what doesn't fit, so add every open item rather than dropping one." },
    date: { type: "string", description: "event: its date as YYYY-MM-DD. Only today's meetings are accepted." },
    facts: { type: "array", items: { type: "string" }, description: "decision/todo: up to 3 chips of 2–6 words (who asked, when, what's at stake). Start one with \"⚠ \" only for a real problem." },
    choices: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" }, draftId: { type: "string", description: "Id of the draft that carries this choice out." } }, required: ["label"] },
      description: "decision: 2 or 3 short answers (2–5 words), the one you'd recommend first.",
    },
    age: { type: "string", description: "decision/todo: how long it has waited, e.g. \"3d\", \"12h\"." },
    title: { type: "string", description: "draft/fyi/event: the title." },
    kind: { type: "string", enum: ["reply", "review", "cards", "note", "other"], description: "draft: what it is." },
    target: { type: "string", description: "draft: where it would go, e.g. \"#release in Slack\", \"Jira CAIRN-212\", \"reply to Kitty's email\"." },
    draft: { type: "string", description: "draft: the full text, ready to send. Never send it yourself." },
    detail: { type: "string", description: "fyi: one short sentence." },
    tone: { type: "string", enum: ["good", "warn", "neutral"], description: "fyi: good news, a warning, or neutral." },
    start: { type: "string", description: "event: start as local HH:MM." },
    end: { type: "string", description: "event: end as local HH:MM." },
    location: { type: "string", description: "event: room or call." },
    note: { type: "string", description: "event: only for a clash or something to prepare." },
    attendees: {
      type: "array", maxItems: 50,
      items: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, self: { type: "boolean", description: "true for the user themself" } } },
      description: "event: who is on the invite, when the calendar says (name and/or email each). Leave it out when the calendar gave no list.",
    },
    seriesId: { type: "string", description: "event: the calendar's id for the recurring series this meeting repeats in, or the series title. Leave it out for one-off meetings." },
    source: { type: "string", description: "The app it came from, e.g. \"Slack\", \"Outlook\", \"Jira\", \"Board\"." },
    url: { type: "string", description: "Link to the original, when the tool result gave one." },
  },
  required: ["lane"],
  };
  // Without People the tool is what it always was: the schema is part of the cached prompt prefix.
  if (!people) {
    delete (schema.properties as Record<string, unknown>).attendees;
    delete (schema.properties as Record<string, unknown>).seriesId;
  }
  return schema;
}

/**
 * `onChange` saves the brief and returns why it couldn't, or null. A failed save fails the tool call,
 * so the model hears about it; the brief in memory keeps the change, and the next save writes it all.
 */
export function todayBriefTools(session: TodayBriefSession, onChange: (brief: TodayBrief) => string | null, people: boolean): AgentTool[] {
  const ITEM_SCHEMA = itemSchema(people);
  const tool = (name: string, description: string, parameters: Record<string, unknown>, run: (args: Record<string, unknown>) => string) =>
    defineTool({
      name, description, parameters: fromJsonSchema(parameters),
      risk: () => ({ class: "WRITE_LOCAL" }),
      execute: async (args) => ({ content: run(args as Record<string, unknown>) }),
    });
  const saved = () => {
    const error = onChange(session.brief);
    if (error) throw new Error(`The brief changed but couldn't be saved: ${error}`);
  };
  const changed = (lines: string[]) => { saved(); return lines.join("\n"); };
  return [
    tool("today_read",
      "Read the Today brief as it stands: the ids, lanes and titles of every item. Call it first on a refresh, so you update items already there instead of adding copies.",
      { type: "object", properties: {} },
      () => JSON.stringify(briefOutline(session.brief))),
    tool("today_upsert",
      "Add or update items on the Today brief, several per call. An id that already exists is replaced, even in another lane. The user sees each item as soon as you add it, so add items as you find them rather than all at the end. Items that fail a check come back with the reason; fix and resend them.",
      { type: "object", properties: { items: { type: "array", items: ITEM_SCHEMA, minItems: 1, maxItems: 12 } }, required: ["items"] },
      (a) => changed(upsertItems(session.brief, Array.isArray(a.items) ? a.items as Record<string, unknown>[] : [], new Date(), people))),
    tool("today_remove",
      "Remove items from the Today brief by id, only when they were handled or are no longer true (answered, merged, closed, cancelled). Never remove an open item to make room: a removed item is gone from the next day's brief too. An item carried from an earlier day needs a reason.",
      {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, minItems: 1 },
          reason: { type: "string", description: "What shows these were handled, e.g. \"Jira says OASIS-12464 is Closed\", \"Liron replied in the thread\"." },
        },
        required: ["ids", "reason"],
      },
      (a) => changed(removeItems(session.brief, Array.isArray(a.ids) ? a.ids.filter((x): x is string => typeof x === "string") : [], new Date(), typeof a.reason === "string" ? a.reason : undefined))),
    tool("today_finish",
      "Finish the brief: the header lines and which apps you read. Call it once, last. Until you do, the brief shows as still gathering.",
      {
        type: "object",
        properties: {
          headline: { type: "string", description: "At most 10 words, verb first, naming the first decision (\"Decide on Edan's P4 interview first.\")." },
          lede: { type: "string", description: "At most 25 words of context. No counts: Cairn shows those." },
          focusId: { type: "string", description: "Id of the decision or to-do to start with." },
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" }, status: { type: "string", enum: ["ok", "empty", "error", "skipped"] },
                items: { type: "number" }, note: { type: "string" },
              },
              required: ["name", "status"],
            },
            description: "One entry per app you tried, including Cairn, with how it went.",
          },
          gap: { type: "string", description: "Optional: one sentence on a missing app that would have helped." },
        },
        required: ["headline", "lede", "sources"],
      },
      (a) => {
        finishBrief(session.brief, a, new Date());
        session.finished = true;
        saved();
        return `Brief finished: ${session.brief.needYou.length} need you, ${session.brief.prepared.length} drafts, ${session.brief.fyi.length} FYI, ${session.brief.events.length} events.`;
      }),
  ];
}
