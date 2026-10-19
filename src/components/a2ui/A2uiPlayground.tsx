"use client";

import React, { useEffect, useMemo, useState } from "react";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import { A2uiSurface } from "@a2ui/react/v0_9";

const SAMPLE: Array<Record<string, unknown>> = [
  { version: "v0.9", createSurface: { surfaceId: "task", catalogId: basicCatalog.id } },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "task",
      components: [
        { id: "root", component: "Card", child: "col" },
        { id: "col", component: "Column", children: ["title", "name", "priority", "done", "actions"] },
        { id: "title", component: "Text", variant: "h3", text: "New task" },
        { id: "name", component: "TextField", label: "Title", value: { path: "/form/title" } },
        {
          id: "priority",
          component: "ChoicePicker",
          label: "Priority",
          options: [
            { label: "Low", value: "low" },
            { label: "Medium", value: "medium" },
            { label: "High", value: "high" },
          ],
          value: { path: "/form/priority" },
        },
        { id: "done", component: "CheckBox", label: "Start in progress", value: { path: "/form/started" } },
        { id: "actions", component: "Row", children: ["create"] },
        { id: "create-label", component: "Text", text: "Create card" },
        {
          id: "create",
          component: "Button",
          child: "create-label",
          action: {
            event: {
              name: "create_card",
              context: {
                title: { path: "/form/title" },
                priority: { path: "/form/priority" },
                started: { path: "/form/started" },
              },
            },
          },
        },
      ],
    },
  },
  {
    version: "v0.9",
    updateDataModel: { surfaceId: "task", path: "/", value: { form: { title: "", priority: ["medium"], started: false } } },
  },
];

type SurfaceProp = React.ComponentProps<typeof A2uiSurface>["surface"];
type LogEntry = { at: string; kind: "action" | "error" | "info"; text: string };

export function A2uiPlayground() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const push = (kind: LogEntry["kind"], text: string) =>
    setLog((l) => [{ at: new Date().toLocaleTimeString(), kind, text }, ...l].slice(0, 50));

  // New processor per "reset" so surfaces start clean.
  const [epoch, setEpoch] = useState(0);
  const processor = useMemo(
    () =>
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      new MessageProcessor([basicCatalog], (action) => {
        push("action", JSON.stringify(action, null, 2));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [epoch],
  );

  const [surfaces, setSurfaces] = useState(() => Array.from(processor.model.surfacesMap.values()));
  useEffect(() => {
    const sync = () => setSurfaces(Array.from(processor.model.surfacesMap.values()));
    sync();
    const c = processor.onSurfaceCreated(sync);
    const d = processor.onSurfaceDeleted(sync);
    return () => { c.unsubscribe(); d.unsubscribe(); };
  }, [processor]);

  const [json, setJson] = useState(() => JSON.stringify(SAMPLE, null, 2));
  const apply = (text: string) => {
    try {
      processor.processMessages(JSON.parse(text) as never);
      push("info", "applied messages");
    } catch (e) {
      push("error", e instanceof Error ? e.message : String(e));
    }
  };

  // Simulates a streaming agent: one message every 700ms.
  const stream = () => {
    setEpoch((e) => e + 1);
    const msgs = SAMPLE;
    msgs.forEach((m, i) => setTimeout(() => {
      // processor identity changes with epoch; resolve at fire time via ref-free closure.
      pendingRef.current?.processMessages([m] as never);
    }, 400 + i * 700));
  };
  const pendingRef = React.useRef<MessageProcessor<never> | null>(null);
  // eslint-disable-next-line react-hooks/refs
  pendingRef.current = processor as unknown as MessageProcessor<never>;

  return (
    <div className="h-full overflow-auto bg-[var(--background)] text-[var(--text-primary)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-sm font-semibold">A2UI spike</h1>
        <span className="text-[0.714rem] text-[var(--text-tertiary)]">@a2ui/react v0.9 · basic catalog</span>
      </div>
      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(22rem,1fr))]">
        <section className="flex flex-col gap-2 min-w-0">
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            spellCheck={false}
            className="h-80 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-[0.714rem]"
          />
          <div className="flex gap-2 text-xs">
            <button className="rounded-md border border-[var(--border)] px-2.5 py-1.5 hover:bg-[var(--surface-2)]" onClick={() => apply(json)}>Apply</button>
            <button className="rounded-md border border-[var(--border)] px-2.5 py-1.5 hover:bg-[var(--surface-2)]" onClick={stream}>Stream sample</button>
            <button className="rounded-md border border-[var(--border)] px-2.5 py-1.5 hover:bg-[var(--surface-2)]" onClick={() => { setEpoch((e) => e + 1); setLog([]); }}>Reset</button>
          </div>
          <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-[0.643rem] max-h-56 overflow-auto">
            {log.length === 0 && <span className="text-[var(--text-tertiary)]">Events and errors appear here.</span>}
            {log.map((l, i) => (
              <pre key={i} className={l.kind === "error" ? "text-[var(--danger)]" : l.kind === "action" ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]"}>
                {l.at} {l.kind}: {l.text}
              </pre>
            ))}
          </div>
        </section>
        <section className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
          {surfaces.length === 0 && <div className="text-xs text-[var(--text-tertiary)]">No surfaces yet — apply messages.</div>}
          {surfaces.map((s) => <A2uiSurface key={s.id} surface={s as unknown as SurfaceProp} />)}
        </section>
      </div>
    </div>
  );
}
