/**
 * Web Worker host for the Knowledge Graph force layout (see force-layout.ts).
 * One worker per mounted ForceGraphCanvas; each "init" replaces the running
 * layout.
 */

import { runForceLayout, PRESETTLE_MS, type ForceLayout, type LayoutRequest, type LayoutResponse } from "./force-layout";

// Typed locally: the renderer's tsconfig uses the DOM lib, and pulling in the
// WebWorker lib alongside it produces conflicting global declarations.
const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(msg: LayoutResponse, transfer?: Transferable[]): void;
};
let layout: ForceLayout | null = null;

scope.onmessage = (ev: MessageEvent<LayoutRequest>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init": {
      layout?.stop();
      const { gen } = msg.init;
      layout = runForceLayout(
        msg.init,
        (positions) => {
          const out: LayoutResponse = { type: "tick", gen, positions };
          scope.postMessage(out, [positions.buffer]);
        },
        () => scope.postMessage({ type: "end", gen } satisfies LayoutResponse),
        // Off the main thread, so the whole settle can run before the first post.
        { presettleMs: PRESETTLE_MS },
      );
      break;
    }
    case "spacing":
      layout?.setSpacing(msg.spacing);
      break;
    case "stop":
      layout?.stop();
      layout = null;
      break;
  }
};
