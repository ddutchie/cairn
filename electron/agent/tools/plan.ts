import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { ok } from "./schema";

export interface PlanDeps {
  /** Called with the markdown plan the model wants approved. */
  onPlan(sessionId: string, plan: string): void;
  /** Whether the session is in plan mode right now. Absent means it is. */
  active?(): boolean;
}

/**
 * Plan mode's way out. READ so it passes the plan-mode gate; it only hands the plan to the human,
 * who approves it (starting an execute turn) or keeps planning.
 *
 * Registered on every turn of a coding session, in or out of plan mode: a tool list that changed
 * when the plan was approved would re-write the provider's cache for the whole conversation.
 */
export function planTools(deps: PlanDeps): AgentTool[] {
  return [
    defineTool({
      name: "exit_plan_mode",
      description: "Plan mode only. Present your finished plan for the user's approval. Pass the full plan as markdown. Call it once the plan is ready, then stop and wait: do not start the work.",
      parameters: Type.Object({ plan: Type.String({ description: "The complete plan, in markdown." }) }),
      risk: () => ({ class: "READ" }),
      execute: async ({ plan }, ctx) => {
        if (deps.active && !deps.active()) return { content: "This session is not in plan mode, so there is no plan to approve. Carry on with the work.", isError: true };
        if (!plan.trim()) return { content: "The plan was empty. Write the plan, then call exit_plan_mode again.", isError: true };
        deps.onPlan(ctx.sessionId, plan);
        return ok("Plan submitted for approval. Stop here and wait for the user's decision.");
      },
    }),
  ];
}
