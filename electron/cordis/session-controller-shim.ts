/**
 * cairn:session-controller — minimal `ctx.sessionController` for dsh-schedule.
 *
 * dsh-schedule 0.1.7 resolves the reminder's Agent through the web API's
 * session controller (`dsh-api-session-controller`), which also cold-resumes
 * parked sessions. Electron has no API layer, so this shim only resolves
 * sessions whose root Agent is already live — the same delivery scope the
 * 0.1.5 overlay had (`ctx.agents.roots()`). A reminder for a session that is
 * not open stays due and is retried on the scheduler's next scan.
 */

import { Service, type Context } from "@deepseek-ai/cordis";

interface AgentLike { session?: { id?: unknown } }

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessionController: CairnSessionController;
  }
}

export class CairnSessionController extends Service {
  static inject = ["agents"];

  constructor(ctx: Context) {
    super(ctx, "sessionController");
  }

  async resolveAgent(sessionId: unknown): Promise<{ agent: AgentLike } | { error: Error }> {
    const roots = (this.ctx as unknown as { agents: { roots(): AgentLike[] } }).agents.roots();
    const agent = roots.find((a) => String(a.session?.id) === String(sessionId));
    return agent ? { agent } : { error: new Error(`session ${String(sessionId)} is not open in Cairn`) };
  }
}

export default CairnSessionController;
