import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool, type ToolOutput } from "../tools";
import { fail, ok } from "./schema";

export interface ChildRun { childId: string; text: string; reason: string }

export interface SubagentDeps {
  /** Run (or continue, with `childId`) a child to the end of its turn. Child asks surface under `parent`. */
  run(parent: string, req: { childId?: string; prompt: string; signal?: AbortSignal }): Promise<ChildRun>;
  list(parent: string): Promise<Array<{ id: string; label: string; running: boolean }>>;
  interrupt(parent: string, childId: string): boolean;
  /** The parent conversation so far, rendered as text, for `delegate`. */
  transcript(parent: string): string;
}

const TRANSCRIPT_CAP = 24_000;

function report(r: ChildRun): ToolOutput {
  if (r.reason === "stop") return ok(`Subagent ${r.childId} finished:\n\n${r.text.trim() || "(no final message)"}`);
  const note = r.reason === "aborted" ? "was stopped" : `ended early (${r.reason})`;
  return { content: `Subagent ${r.childId} ${note}.${r.text.trim() ? `\n\nLast message:\n${r.text.trim()}` : ""}`, isError: true };
}

/**
 * Children are ordinary sessions with their own log. They get the parent's tools minus these (one level of
 * delegation), the parent's approval mode, and ask through the parent so the human answers in one place.
 */
export function subagentTools(deps: SubagentDeps): AgentTool[] {
  const description = Type.String({ description: "A short (3-5 word) description of the task, for display." });
  return [
    defineTool({
      name: "subagent",
      description: "Delegate a self-contained task to a subagent: a separate agent that works in its own context, so focused work (research, a scoped implementation, an analysis) does not fill this conversation. It returns its final report, not its steps. Several calls in one message run in parallel. The subagent cannot delegate further.",
      parameters: Type.Object({ description, prompt: Type.String({ description: "Everything the subagent needs: it sees none of this conversation." }) }),
      risk: () => ({ class: "READ" }),
      concurrency: "parallel",
      preview: (a) => a.description,
      execute: async (a, ctx) => report(await deps.run(ctx.sessionId, { prompt: a.prompt, signal: ctx.signal })),
    }),
    defineTool({
      name: "delegate",
      description: "Like `subagent`, but the child is shown the conversation so far. Use it when the subtask builds on this conversation (a review, a follow-up analysis). Continue it later with `send_message`.",
      parameters: Type.Object({ description, prompt: Type.String({ description: "What the child should do with that context." }) }),
      risk: () => ({ class: "READ" }),
      concurrency: "parallel",
      preview: (a) => a.description,
      execute: async (a, ctx) => {
        const transcript = deps.transcript(ctx.sessionId).slice(-TRANSCRIPT_CAP);
        const prompt = transcript ? `<parent_conversation>\n${transcript}\n</parent_conversation>\n\n${a.prompt}` : a.prompt;
        return report(await deps.run(ctx.sessionId, { prompt, signal: ctx.signal }));
      },
    }),
    defineTool({
      name: "send_message",
      description: "Continue a subagent you started: send it a follow-up and wait for its reply. Use the id from its earlier report or `list_agents`.",
      parameters: Type.Object({ id: Type.String({ description: "The subagent id." }), message: Type.String() }),
      risk: () => ({ class: "READ" }),
      concurrency: "parallel",
      execute: async (a, ctx) => {
        const known = (await deps.list(ctx.sessionId)).find((c) => c.id === a.id);
        if (!known) return fail(`No subagent ${a.id} belongs to this session.`);
        if (known.running) return fail(`Subagent ${a.id} is still working; wait for it or interrupt it first.`);
        return report(await deps.run(ctx.sessionId, { childId: a.id, prompt: a.message, signal: ctx.signal }));
      },
    }),
    defineTool({
      name: "list_agents",
      description: "List the subagents this session has started and whether each is still running.",
      parameters: Type.Object({}),
      risk: () => ({ class: "READ" }),
      concurrency: "parallel",
      execute: async (_a, ctx) => {
        const children = await deps.list(ctx.sessionId);
        return ok(children.length ? children.map((c) => `${c.id}  ${c.running ? "running" : "idle"}  ${c.label}`).join("\n") : "No subagents yet.");
      },
    }),
    defineTool({
      name: "interrupt_agent",
      description: "Stop a running subagent's current turn.",
      parameters: Type.Object({ id: Type.String({ description: "The subagent id." }) }),
      risk: () => ({ class: "READ" }),
      execute: async (a, ctx) => (deps.interrupt(ctx.sessionId, a.id) ? ok(`Interrupted ${a.id}.`) : fail(`${a.id} is not running.`)),
    }),
  ];
}
