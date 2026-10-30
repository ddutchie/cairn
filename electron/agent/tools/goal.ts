/** get_goal / create_goal / update_goal: the session's standing objective. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import type { GoalPhase, GoalState } from "../events";
import { fail, ok } from "./schema";

export interface GoalDeps {
  get(): GoalState | null;
  create(objective: string, maxRounds?: number): Promise<GoalState>;
  update(patch: { phase?: GoalPhase; blockedReason?: string }): Promise<GoalState | undefined>;
}

const describe = (g: GoalState) =>
  `Goal ${g.id} [${g.phase}] round ${g.roundsStarted}/${g.maxGoalRounds}: ${g.objective}${g.blockedReason ? ` (blocked: ${g.blockedReason})` : ""}`;

export function goalTools(deps: GoalDeps): AgentTool[] {
  const read = () => ({ class: "READ" as const });
  return [
    defineTool({
      name: "get_goal",
      description: "Read the session's current goal, if any.",
      parameters: Type.Object({}),
      risk: read,
      async execute() {
        const g = deps.get();
        return ok(g ? describe(g) : "No goal is set.");
      },
    }),
    defineTool({
      name: "create_goal",
      description: "Set a goal for this session. After each turn ends without the goal being finished you are prompted to continue, up to maxRounds times.",
      parameters: Type.Object({
        objective: Type.String({ description: "What done looks like, concretely." }),
        maxRounds: Type.Optional(Type.Number({ description: "Most continuation rounds (default 10)." })),
      }),
      risk: read,
      async execute(a) {
        if (!a.objective.trim()) return fail("objective must not be empty");
        return ok(describe(await deps.create(a.objective.trim(), a.maxRounds)));
      },
    }),
    defineTool({
      name: "update_goal",
      description: "Update the current goal. Use phase 'complete' once the objective is met, 'blocked' (with blockedReason) when you cannot proceed, 'paused' to stop for now.",
      parameters: Type.Object({
        phase: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("blocked"), Type.Literal("complete")])),
        blockedReason: Type.Optional(Type.String()),
      }),
      risk: read,
      async execute(a) {
        const g = await deps.update(a);
        return g ? ok(describe(g)) : fail("No goal is set.");
      },
    }),
  ];
}
