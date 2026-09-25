/**
 * Main-thread handle on the force layout: a Web Worker when one can be
 * started, otherwise the same engine run in-thread. Also keeps each graph's
 * last settled positions in memory so reopening the view resumes from them.
 */

import { runForceLayout, type ForceLayout, type LayoutInit, type LayoutRequest, type LayoutResponse } from "./force-layout";

export interface LayoutHandlers {
  onTick: (gen: number, positions: Float32Array) => void;
  onEnd: (gen: number) => void;
}

export interface ForceLayoutClient {
  init(init: LayoutInit): void;
  setSpacing(spacing: number): void;
  dispose(): void;
}

/** Runs the layout in-thread (no Worker available, or the worker failed). */
function localClient(h: LayoutHandlers): ForceLayoutClient {
  let layout: ForceLayout | null = null;
  return {
    init(init) {
      layout?.stop();
      layout = runForceLayout(init, (p) => h.onTick(init.gen, p), () => h.onEnd(init.gen));
    },
    setSpacing(spacing) { layout?.setSpacing(spacing); },
    dispose() { layout?.stop(); layout = null; },
  };
}

export function createForceLayoutClient(h: LayoutHandlers): ForceLayoutClient {
  let worker: Worker | null = null;
  try {
    if (typeof Worker !== "undefined") {
      worker = new Worker(new URL("./force-layout.worker.ts", import.meta.url), { type: "module" });
    }
  } catch {
    worker = null;
  }
  if (!worker) return localClient(h);

  // If the worker dies (blocked script, runtime error), finish the current
  // layout on the main thread instead of leaving the graph frozen.
  let fallback: ForceLayoutClient | null = null;
  let lastInit: LayoutInit | null = null;
  let lastSpacing: number | null = null;
  const send = (msg: LayoutRequest) => worker?.postMessage(msg);

  worker.onmessage = (ev: MessageEvent<LayoutResponse>) => {
    const msg = ev.data;
    if (msg.type === "tick") h.onTick(msg.gen, msg.positions);
    else h.onEnd(msg.gen);
  };
  worker.onerror = (ev) => {
    ev.preventDefault();
    worker?.terminate();
    worker = null;
    fallback = localClient(h);
    if (lastInit) fallback.init(lastSpacing != null ? { ...lastInit, spacing: lastSpacing } : lastInit);
  };

  return {
    init(init) {
      lastInit = init;
      lastSpacing = null;
      if (fallback) fallback.init(init);
      else send({ type: "init", init });
    },
    setSpacing(spacing) {
      lastSpacing = spacing;
      if (fallback) fallback.setSpacing(spacing);
      else send({ type: "spacing", spacing });
    },
    dispose() {
      fallback?.dispose();
      worker?.terminate();
      worker = null;
    },
  };
}

// ── remembered layouts ────────────────────────────────────────────────────────

type Positions = Map<string, { x: number; y: number }>;

/** Keep a handful of graphs (workspaces); older ones are dropped. */
const MAX_REMEMBERED = 8;
const remembered = new Map<string, Positions>();

/** Merge `positions` into what's remembered for `key`. Merging (rather than
 *  replacing) keeps nodes that a search or filter hid when the view closed. */
export function rememberLayout(key: string, positions: Positions): void {
  const merged = remembered.get(key) ?? new Map();
  for (const [id, p] of positions) merged.set(id, p);
  remembered.delete(key);
  remembered.set(key, merged);
  while (remembered.size > MAX_REMEMBERED) {
    remembered.delete(remembered.keys().next().value!);
  }
}

export function recallLayout(key: string): Positions | undefined {
  return remembered.get(key);
}
