/**
 * Subagents: spawning children, listing and messaging them, and the goal and
 * schedule snapshots. (F5/B4: split out of `electron/ipc/engine-bridge.ts`; no
 * logic changes.)
 */
import { randomBytes } from "node:crypto";
import type { DbContext } from "../result-helpers";
import { getEngineHost } from "./host";
import type { SubagentDeps } from "../../agent/tools/subagent";
import { ensureSessionState, getSessionState } from "./session-state";

const SUBAGENT_PROMPT = "\n\n## Subagent\nYou are a subagent working for another agent. Do the task you were given and finish with a concise report of what you found or did. You cannot start further subagents.";

function controlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function subagentDeps(ctx: DbContext): SubagentDeps {
  const host = (): ReturnType<typeof getEngineHost> => getEngineHost(ctx);
  return {
    run: async (parent, req) => {
      const sc = getSessionState(parent)?.spawn;
      if (!sc) throw controlError("parent-unavailable", "Subagents are unavailable for this session.");
      const childId = req.childId ?? `${parent}.sub-${randomBytes(4).toString("hex")}`;
      const fromParent = getSessionState(parent);
      const child = ensureSessionState(childId);
      if (fromParent?.usage) child.usage = fromParent.usage;
      child.rules = fromParent?.rules ?? [];
      if (fromParent?.workspaceId) child.workspaceId = fromParent.workspaceId;
      const out = await host().prompt({
        sessionId: childId, parentSession: parent, prompt: req.prompt, cwd: sc.cwd, profile: sc.profile, route: sc.route,
        systemPrompt: `${sc.systemPrompt}${SUBAGENT_PROMPT}`, tools: sc.tools(), reasoningEffort: sc.reasoningEffort,
        temperature: sc.temperature, maxSteps: sc.maxSteps, signal: req.signal,
      });
      return { childId, ...out };
    },
    list: (parent) => host().listChildren(parent),
    interrupt: (parent, childId) => {
      if (!childId.startsWith(`${parent}.sub-`) || !host().isRunning(childId)) return false;
      host().abort(childId);
      return true;
    },
    transcript: (parent) => host().transcript(parent),
  };
}

/** The subagent catalog for the header popover. Children only: delegation is one level deep. */
/** Drop what a closed or cleared session left in memory. */
/** Snapshots for the goal chip, the alarm pill and the jobs dock. */
export async function readEngineGoal(ctx: DbContext, sessionId: string) {
  const g = await getEngineHost(ctx).readGoal(sessionId);
  return g ? { ...g, blockedReason: g.blockedReason ? { code: "blocked", message: g.blockedReason } : undefined } : null;
}

export async function listEngineSchedules(ctx: DbContext, sessionId: string) {
  const now = Date.now();
  return (await getEngineHost(ctx).readSchedules(sessionId)).map((s) => ({ id: s.id, prompt: s.prompt, scheduledAt: s.at, kind: s.kind, state: Date.parse(s.at) < now ? "overdue" as const : "scheduled" as const }));
}

export async function listEngineSubagents(ctx: DbContext, parent: string): Promise<{ entries: Array<{ id: string; mode: "continuable"; label: string; activity: "running" | "inactive"; live: boolean; hasChildren: boolean }>; parentAvailable: boolean }> {
  const children = await getEngineHost(ctx).listChildren(parent);
  return {
    entries: children.map((c) => ({ id: c.id, mode: "continuable" as const, label: c.label, activity: c.running ? "running" as const : "inactive" as const, live: c.running, hasChildren: false })),
    parentAvailable: getSessionState(parent)?.spawn !== undefined,
  };
}

export function interruptEngineSubagent(ctx: DbContext, parent: string, childId: string): { accepted: true } {
  subagentDeps(ctx).interrupt(parent, childId);
  return { accepted: true };
}

/** A human follow-up to a finished child. Runs in the background; the trace shows the reply. */
export async function messageEngineSubagent(ctx: DbContext, parent: string, childId: string, text: string): Promise<{ messageId: string }> {
  const deps = subagentDeps(ctx);
  if (!getSessionState(parent)?.spawn) throw controlError("parent-unavailable", "Send the session a prompt first; its subagents can be messaged once it is running again.");
  const known = (await deps.list(parent)).find((c) => c.id === childId);
  if (!known) throw controlError("bad-request", "Unknown subagent.");
  if (known.running) throw controlError("delivery-unavailable", "The subagent is still working.");
  void deps.run(parent, { childId, prompt: text }).catch((err) => console.warn("[agent] subagent message failed:", err instanceof Error ? err.message : err));
  return { messageId: childId };
}
