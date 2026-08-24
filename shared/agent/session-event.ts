/** The transport envelope for an unmodified DSH session/event notification. */
export interface SessionEventEnvelope {
  sessionId: string;
  /** Structural on purpose: preload and renderer must not depend on Electron types. */
  event: {
    type: string;
    seq: number;
    time: number;
    data: unknown;
    [key: string]: unknown;
  };
}

export function sessionEventEnvelope(sessionId: string, event: SessionEventEnvelope["event"]): SessionEventEnvelope {
  return { sessionId, event };
}
