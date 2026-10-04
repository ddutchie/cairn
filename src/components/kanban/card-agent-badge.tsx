"use client";

import { createContext, useContext } from "react";
import { Bot } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Running coding-session ids, provided once by the board (from the coalesced
 * `session:running-ids` poller) so each card badge doesn't poll on its own.
 */
export const RunningSessionsContext = createContext<ReadonlySet<string>>(new Set());

/**
 * "Agent working" / "Agent needs you" pill on a board card whose coding
 * session (spawned from the card) is running. Click opens the session.
 *
 * The store selector returns a primitive key so the badge only re-renders when
 * this card's agent state changes — not on every streamed token.
 */
export function CardAgentBadge({ cardId }: { cardId: string }) {
  const running = useContext(RunningSessionsContext);
  const status = useCairnStore((s) => {
    if (running.size === 0) return null;
    const t = s.terminalSessions.find((x) => x.sessionType === "coding" && x.taskId === cardId && running.has(x.sessionId));
    if (!t) return null;
    const waiting = (t.messages ?? []).some((m) => m.toolCalls?.some((tc) => tc.confirmRequired));
    return `${t.sessionId}\u0000${waiting ? "waiting" : "running"}`;
  });
  const openSession = useCairnStore((s) => s.openSession);
  if (!status) return null;
  const [sessionId, state] = status.split("\u0000");
  const waiting = state === "waiting";

  return (
    <Tooltip content={waiting ? "The agent is waiting for your approval — open session" : "An agent is working on this card — open session"}>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); openSession(sessionId, "coding"); }}
        className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[0.643rem] font-medium flex-shrink-0",
          waiting ? "text-[var(--warning)]" : "text-[var(--accent)]",
        )}
        style={{ background: `color-mix(in srgb, ${waiting ? "var(--warning)" : "var(--accent)"} 14%, transparent)` }}
        aria-label={waiting ? "Agent needs approval" : "Agent working"}
      >
        <Bot size={10} className={cn(!waiting && "animate-pulse")} />
        {waiting ? "Needs you" : "Agent"}
      </button>
    </Tooltip>
  );
}
