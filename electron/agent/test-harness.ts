/** Shared fixtures for the agent kernel tests: faux model, tools, driver. */
import { createModels, fauxProvider, Type, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent } from "./events";
import { Gate } from "./gate";
import type { Profile, StreamFn, TurnOptions } from "./loop";
import { createRuleStore, type Rule } from "./rules";
import { defineTool, type AgentTool } from "./tools";

export const WORKSPACE = "/ws";

export interface Executed { name: string; args: unknown }

export function makeTools(executed: Executed[]): AgentTool[] {
  const record = (name: string, args: unknown) => { executed.push({ name, args }); };
  return [
    defineTool({
      name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }),
      risk: () => ({ class: "READ" }), concurrency: "parallel",
      execute: async (args) => { record("echo", args); return { content: `echo:${args.text}` }; },
    }),
    defineTool({
      name: "note_write", description: "Write a note", parameters: Type.Object({ title: Type.String() }),
      risk: () => ({ class: "WRITE_CAIRN" }),
      execute: async (args) => { record("note_write", args); return { content: "saved" }; },
    }),
    defineTool({
      name: "write_file", description: "Write a file", parameters: Type.Object({ path: Type.String() }),
      risk: (args) => ({ class: "WRITE_LOCAL", paths: [args.path] }),
      preview: (args) => args.path,
      execute: async (args) => { record("write_file", args); return { content: `wrote ${args.path}` }; },
    }),
    defineTool({
      name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }),
      risk: (args) => ({ class: "EXEC", command: args.command }),
      execute: async (args) => { record("bash", args); return { content: `ran ${args.command}` }; },
    }),
    defineTool({
      name: "boom", description: "Always throws", parameters: Type.Object({}),
      risk: () => ({ class: "READ" }),
      execute: async () => { throw new Error("kaboom"); },
    }),
  ];
}

export interface Harness {
  faux: ReturnType<typeof fauxProvider>;
  gate: Gate;
  history: Message[];
  executed: Executed[];
  rules: ReturnType<typeof createRuleStore>;
  /** Build TurnOptions with sensible defaults; override per test. */
  opts(overrides?: Partial<TurnOptions>): TurnOptions;
}

export function makeHarness(init: { rules?: Rule[]; profile?: Partial<Profile>; tools?: AgentTool[] } = {}): Harness {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const streamFn: StreamFn = (m, c, o) => models.streamSimple(m, c, o);
  const gate = new Gate();
  const history: Message[] = [];
  const executed: Executed[] = [];
  const rules = createRuleStore(init.rules ?? []);
  const tools = init.tools ?? makeTools(executed);
  const profile: Profile = { id: "test", interactive: true, mode: "ask", ...init.profile };
  return {
    faux, gate, history, executed, rules,
    opts: (overrides = {}) => ({
      sessionId: "s1", model: faux.getModel(), streamFn, history, input: "go", tools, profile, rules, gate,
      workspaceRoot: WORKSPACE, askTtlMs: 2_000, ...overrides,
    }),
  };
}

type Responder = (ev: AgentEvent) => void | Promise<void>;

/** Drain a turn, optionally reacting to events (e.g. answering approvals). */
export async function drive(gen: AsyncGenerator<AgentEvent>, respond?: Responder): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
    await respond?.(ev);
  }
  return events;
}

export const types = (events: AgentEvent[]): string[] => events.map((e) => e.type);
export const ofType = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
export const toolResults = (history: Message[]): ToolResultMessage[] =>
  history.filter((m): m is ToolResultMessage => m.role === "toolResult");
