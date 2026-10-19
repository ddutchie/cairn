"use client";

import React, { useEffect, useMemo, useState } from "react";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import { A2uiSurface } from "@a2ui/react/v0_9";
import { formatA2uiAction, useA2uiActionSender } from "./a2ui-action-context";
import "./a2ui-theme.css";

// Remember a submitted surface across reloads (the transcript re-renders it from
// the saved tool args, which carry no record of the user's action).
const submittedKey = (callId: string) => `a2ui-submitted:${callId}`;
function readSubmitted(callId?: string): string | null {
  if (!callId) return null;
  try { return localStorage.getItem(submittedKey(callId)); } catch { return null; }
}
function writeSubmitted(callId: string | undefined, text: string) {
  if (!callId) return;
  try { localStorage.setItem(submittedKey(callId), text); } catch { /* storage unavailable */ }
}

type SurfaceProp = React.ComponentProps<typeof A2uiSurface>["surface"];

interface Props {
  callId?: string;
  title?: string;
  messages: unknown[];
}

/** Renders the surfaces described by a `render_ui` tool call's messages. */
export default function A2uiToolSurface({ callId, title, messages }: Props) {
  const send = useA2uiActionSender();
  const [sent, setSent] = useState<string | null>(() => readSubmitted(callId));
  const [error, setError] = useState<string | null>(null);

  // The handler reads `send` through a ref-like closure so a context change
  // doesn't rebuild the processor (which would reset the user's form input).
  const sendRef = React.useRef(send);
  useEffect(() => { sendRef.current = send; }, [send]);

  // Key on content, not array identity: a re-render with an equal payload must
  // not rebuild the processor (that would wipe the user's form input).
  const payloadKey = JSON.stringify(messages);
  const processor = useMemo(() => {
    const p = new MessageProcessor([basicCatalog], (action) => {
      const text = formatA2uiAction(action as { name?: string; context?: unknown });
      setSent(text);
      writeSubmitted(callId, text);
      sendRef.current?.(text);
    });
    try {
      p.processMessages(JSON.parse(payloadKey) as never);
    } catch (e) {
      // Surfaced below; agent output is untrusted and may not validate.
      queueMicrotask(() => setError(e instanceof Error ? e.message : String(e)));
    }
    return p;
  }, [payloadKey, callId]);

  const [surfaces, setSurfaces] = useState(() => Array.from(processor.model.surfacesMap.values()));
  useEffect(() => {
    const sync = () => setSurfaces(Array.from(processor.model.surfacesMap.values()));
    sync();
    const c = processor.onSurfaceCreated(sync);
    const d = processor.onSurfaceDeleted(sync);
    return () => { c.unsubscribe(); d.unsubscribe(); };
  }, [processor]);

  return (
    <div data-testid="a2ui-surface" className="w-full max-w-xl rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
      {title && <div className="mb-1.5 text-[0.786rem] font-medium text-[var(--text-primary)]">{title}</div>}
      {error && <div className="text-[0.714rem] text-[var(--danger)]">Couldn&apos;t render UI: {error}</div>}
      <div className="cairn-a2ui" data-submitted={sent ? "true" : "false"} inert={sent ? true : undefined}>
        {surfaces.map((s) => <A2uiSurface key={s.id} surface={s as unknown as SurfaceProp} />)}
      </div>
      {sent && <div className="mt-1.5 text-[0.643rem] text-[var(--text-tertiary)]">Submitted · {sent.replace(/^\[UI action\] /, "")}</div>}
    </div>
  );
}
