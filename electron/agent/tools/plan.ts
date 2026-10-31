import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { ok } from "./schema";

export interface PlanDeps {
  /** Called with the markdown plan the model wants approved. */
  onPlan(sessionId: string, plan: string): void;
}

/**
 * Plan mode's way out. READ so it passes the plan-mode gate; it only hands the plan to the human,
 * who approves it (starting an execute turn) or keeps planning.
 */
export function planTools(deps: PlanDeps): AgentTool[] {
  return [
    defineTool({
      name: "exit_plan_mode",
      description: "Present your finished plan for the user's approval. Pass the full plan as markdown. Call it once the plan is ready, then stop and wait: do not start the work.",
      parameters: Type.Object({ plan: Type.String({ description: "The complete plan, in markdown." }) }),
      risk: () => ({ class: "READ" }),
      execute: async ({ plan }, ctx) => {
        if (!plan.trim()) return { content: "The plan was empty. Write the plan, then call exit_plan_mode again.", isError: true };
        deps.onPlan(ctx.sessionId, plan);
        return ok("Plan submitted for approval. Stop here and wait for the user's decision.");
      },
    }),
  ];
}
