/**
 * In-page probe for the graph canvas benchmark, installed with
 * `page.addInitScript` before the app boots.
 *
 * - Frame timing: a rAF loop records frame-to-frame intervals while a
 *   measurement is running.
 * - rAF callback time: every requestAnimationFrame callback is timed, so a
 *   scenario can tell JS draw time apart from raster/compositor time (the rest
 *   of the frame).
 * - Canvas call counts: the 2D context methods that dominate canvas cost are
 *   counted per measurement.
 * - Experiments: `window.__perfFlags` switches off one canvas feature at a time
 *   (dashed lines, text, shadows) without touching app code, so a variant run
 *   shows how much of the frame that feature costs.
 */

export interface PerfFlags {
  noDash?: boolean;
  noText?: boolean;
  noShadow?: boolean;
}

export interface ProbeResult {
  frames: number;
  durationMs: number;
  intervals: number[];
  rafCallbackMs: number[];
  calls: Record<string, number>;
  longTasks: number;
  longTaskMs: number;
  /** ms from start to the first node fill (first graph pixels), or null. */
  firstFillMs: number | null;
}

export function frameProbeScript(flags: PerfFlags): string {
  return /* js */ `
(() => {
  const flags = ${JSON.stringify(flags)};
  window.__perfFlags = flags;
  const P = CanvasRenderingContext2D.prototype;
  const COUNTED = ["clearRect", "stroke", "fill", "fillText", "strokeText", "arc", "setLineDash", "save", "restore", "createRadialGradient", "measureText"];
  const state = { on: false, calls: {}, rafMs: [], intervals: [], longTasks: 0, longTaskMs: 0, t0: 0, firstFill: null, stopAt: 0 };
  window.__perfState = state;

  for (const name of COUNTED) {
    const orig = P[name];
    P[name] = function (...args) {
      if (state.on) {
        state.calls[name] = (state.calls[name] || 0) + 1;
        if (name === "fill" && state.firstFill == null) state.firstFill = performance.now() - state.t0;
      }
      if (flags.noText && (name === "fillText" || name === "strokeText")) return;
      if (flags.noDash && name === "setLineDash") return orig.call(this, []);
      return orig.apply(this, args);
    };
  }
  if (flags.noShadow) {
    Object.defineProperty(P, "shadowBlur", { set() {}, get() { return 0; }, configurable: true });
  }

  // Time every rAF callback (the force canvas draws in rAF; the radial
  // drill-in animation ticks in rAF).
  const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => origRaf((ts) => {
    if (!state.on || cb.__perfLoop) return cb(ts);
    const s = performance.now();
    try { return cb(ts); } finally { state.rafMs.push(performance.now() - s); }
  });

  // Long tasks count by when they ran (inside the start..stop window), not
  // by when the observer delivered them; stop drains what is still queued.
  let longObs = null;
  const takeLong = (list) => {
    for (const e of list) {
      if (e.startTime < state.t0 || e.startTime > state.stopAt) continue;
      state.longTasks++; state.longTaskMs += e.duration;
    }
  };
  try {
    longObs = new PerformanceObserver((list) => { if (state.on || state.stopAt) takeLong(list.getEntries()); });
    longObs.observe({ type: "longtask", buffered: false });
  } catch {}

  let last = 0;
  const loop = (ts) => {
    if (state.on && last) state.intervals.push(ts - last);
    last = ts;
    origRaf(loop);
  };
  loop.__perfLoop = true;
  origRaf(loop);

  window.__perfStart = () => {
    state.on = true; state.calls = {}; state.rafMs = []; state.intervals = [];
    state.longTasks = 0; state.longTaskMs = 0; state.t0 = performance.now(); state.firstFill = null; state.stopAt = Infinity; last = 0;
  };
  window.__perfStop = () => {
    state.on = false;
    state.stopAt = performance.now();
    if (longObs) takeLong(longObs.takeRecords());
    return {
      frames: state.intervals.length,
      durationMs: performance.now() - state.t0,
      intervals: state.intervals,
      rafCallbackMs: state.rafMs,
      calls: state.calls,
      longTasks: state.longTasks,
      longTaskMs: state.longTaskMs,
      firstFillMs: state.firstFill,
    };
  };
})();
`;
}
