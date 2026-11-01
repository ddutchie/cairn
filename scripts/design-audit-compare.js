#!/usr/bin/env node
/**
 * Cairn — design audit before/after comparison page
 *
 * Reads the screenshots captured by `npm run screenshots:audit` into
 * design-audit/before/<theme>/ and design-audit/after/<theme>/ and writes a
 * self-contained design-audit/compare.html (git-ignored) that references them
 * by relative path. Open it straight from disk.
 *
 * Typical loop for a phase:
 *   AUDIT_OUT=before npm run screenshots:audit   # on the base branch
 *   …make changes…
 *   AUDIT_OUT=after npm run screenshots:audit
 *   npm run screenshots:compare
 *
 * "Changed" is a pixel comparison done in headless Chromium (Playwright is
 * already a dev dependency): byte-identical files short-circuit, and PNGs that
 * differ only in encoding count as unchanged. Each changed shot also records
 * the bounding box of its changed pixels, which the page outlines.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.resolve(__dirname, "..", "design-audit");
const THEMES = ["light", "dark"];

const hash = (file) => crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".png")) : []);

// "21-settings-ai-chat.png" → "Settings · AI chat"
function title(file) {
  const words = file.replace(/^\d+-/, "").replace(/\.png$/, "").split("-");
  const special = { ai: "AI", mcp: "MCP", prd: "PRD", ext: "Extensions" };
  const text = words.map((w) => special[w] ?? w).join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function group(file) {
  const n = parseInt(file, 10);
  if (n < 20) return "Views and chat";
  if (n < 40) return "Settings";
  if (n < 50) return "Modals and menus";
  if (n < 60) return "Onboarding";
  return "Narrow window";
}

async function main() {
const shots = [];
for (const theme of THEMES) {
  const before = path.join(root, "before", theme);
  const after = path.join(root, "after", theme);
  const names = [...new Set([...list(before), ...list(after)])].sort();
  for (const file of names) {
    const b = path.join(before, file);
    const a = path.join(after, file);
    const hasB = fs.existsSync(b);
    const hasA = fs.existsSync(a);
    shots.push({
      theme,
      file,
      title: title(file),
      group: group(file),
      before: hasB ? `before/${theme}/${file}` : null,
      after: hasA ? `after/${theme}/${file}` : null,
      status: !hasB ? "new" : !hasA ? "missing" : hash(b) === hash(a) ? "same" : "changed",
      box: null,
      _b: b,
      _a: a,
    });
  }
}

await pixelDiff(shots.filter((s) => s.status === "changed"));
for (const s of shots) { delete s._a; delete s._b; }

if (shots.length === 0) {
  console.error("[compare] No screenshots in design-audit/before or design-audit/after. Run `AUDIT_OUT=before npm run screenshots:audit` first.");
  process.exit(1);
}

const label = process.env.COMPARE_LABEL ?? "Before / after";
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cairn design audit</title>
<style>
  :root {
    --bg: #f4f3ef; --surface: #fbfaf7; --surface-2: #ecebe5; --border: #dcdad3;
    --text: #1a1917; --text-2: #4a4744; --text-3: #8a8680;
    --accent: #5b7a3a; --accent-dim: color-mix(in srgb, #5b7a3a 14%, transparent);
    --changed: #b7791f; --new: #2f6fb3;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #141413; --surface: #1b1b19; --surface-2: #242421; --border: #34332f;
      --text: #e8e4dc; --text-2: #9e9a94; --text-3: #6f6b66;
      --accent: #9dbb78; --accent-dim: color-mix(in srgb, #9dbb78 16%, transparent);
      --changed: #e0a54a; --new: #74a7e0;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 13px/1.45 ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", sans-serif;
    display: grid; grid-template-columns: 260px 1fr; grid-template-rows: auto 1fr;
  }
  header {
    grid-column: 1 / -1; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--surface);
  }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; }
  header .summary { color: var(--text-3); }
  .spacer { flex: 1; }
  .seg { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--surface-2); gap: 2px; }
  .seg button {
    border: 0; background: transparent; color: var(--text-2); font: inherit; font-size: 12px;
    padding: 4px 10px; border-radius: 6px; cursor: pointer;
  }
  .seg button[aria-pressed="true"] { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px color-mix(in srgb, black 12%, transparent); }
  .seg button:focus-visible, .shot:focus-visible, label:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
  label.check { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); font-size: 12px; cursor: pointer; }
  nav { overflow-y: auto; border-right: 1px solid var(--border); padding: 8px; background: var(--surface); }
  nav h2 { font-size: 11px; font-weight: 500; color: var(--text-3); margin: 14px 8px 4px; }
  nav h2:first-child { margin-top: 4px; }
  .shot {
    display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
    border: 0; background: transparent; color: var(--text-2); font: inherit; font-size: 12.5px;
    padding: 6px 8px; border-radius: 6px; cursor: pointer;
  }
  .shot:hover { background: var(--surface-2); color: var(--text); }
  .shot[aria-current="true"] { background: var(--accent-dim); color: var(--accent); font-weight: 500; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: transparent; border: 1px solid var(--border); }
  .dot.changed { background: var(--changed); border-color: var(--changed); }
  .dot.new { background: var(--new); border-color: var(--new); }
  .shot .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  main { overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .stage-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .stage-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .status { font-size: 12px; color: var(--text-3); }
  .status.changed { color: var(--changed); }
  .status.new { color: var(--new); }
  .hint { margin-left: auto; color: var(--text-3); font-size: 12px; }
  kbd { font: 11px ui-monospace, monospace; padding: 1px 5px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  figure { margin: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  figcaption { font-size: 12px; color: var(--text-3); }
  img { display: block; width: 100%; height: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); }
  .frame { position: relative; border-radius: 6px; overflow: hidden; user-select: none; }
  .frame img { border-radius: 0; }
  .frame .top { position: absolute; inset: 0; clip-path: inset(0 0 0 var(--split, 50%)); }
  .frame .top img { border: 0; }
  .handle { position: absolute; top: 0; bottom: 0; left: var(--split, 50%); width: 2px; background: var(--accent); pointer-events: none; }
  .handle::after {
    content: ""; position: absolute; top: 50%; left: -7px; width: 16px; height: 32px; margin-top: -16px;
    border-radius: 4px; background: var(--accent);
  }
  .tag { position: absolute; top: 8px; padding: 2px 8px; font-size: 11px; border-radius: 4px; background: color-mix(in srgb, black 60%, transparent); color: white; }
  .tag.l { left: 8px; } .tag.r { right: 8px; }
  .diff { position: relative; }
  .diff .top { position: absolute; inset: 0; mix-blend-mode: difference; }
  .diff .top img { border: 0; }
  .after-wrap { position: relative; }
  .region { position: absolute; border: 2px solid var(--changed); border-radius: 3px; pointer-events: none;
    box-shadow: 0 0 0 9999px color-mix(in srgb, black 8%, transparent); }
  .empty { padding: 48px; text-align: center; color: var(--text-3); border: 1px dashed var(--border); border-radius: 6px; }
  @media (max-width: 760px) {
    body { grid-template-columns: 1fr; grid-template-rows: auto auto 1fr; }
    nav { max-height: 40vh; border-right: 0; border-bottom: 1px solid var(--border); }
    .pair { grid-template-columns: 1fr; }
    .hint { display: none; }
  }
  @media (prefers-reduced-motion: no-preference) { .shot, .seg button { transition: background-color .12s, color .12s; } }
</style>
</head>
<body>
<header>
  <h1>Cairn design audit</h1>
  <span class="summary" id="summary"></span>
  <span class="spacer"></span>
  <div class="seg" role="group" aria-label="Theme" id="themes"></div>
  <div class="seg" role="group" aria-label="Comparison mode" id="modes"></div>
  <label class="check"><input type="checkbox" id="changedOnly"> Changed only</label>
</header>
<nav id="list" aria-label="Screenshots"></nav>
<main id="stage" aria-live="polite"></main>
<script>
const SHOTS = ${JSON.stringify(shots)};
const LABEL = ${JSON.stringify(label)};
const MODES = [["side", "Side by side"], ["slider", "Slider"], ["flip", "Flip"], ["diff", "Difference"]];
const store = {
  get(k, d) { try { return localStorage.getItem("audit:" + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("audit:" + k, v); } catch {} },
};
const state = {
  theme: store.get("theme", "light"),
  mode: store.get("mode", "side"),
  changedOnly: store.get("changedOnly", "0") === "1",
  file: store.get("file", null),
  split: 50,
  flipped: false,
};
const $ = (id) => document.getElementById(id);

function visible() {
  return SHOTS.filter((s) => s.theme === state.theme && (!state.changedOnly || s.status !== "same"));
}

function seg(el, items, current, onPick) {
  el.innerHTML = "";
  for (const [value, text] of items) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = text;
    b.setAttribute("aria-pressed", String(value === current));
    b.onclick = () => onPick(value);
    el.appendChild(b);
  }
}

function renderChrome() {
  const themes = [...new Set(SHOTS.map((s) => s.theme))];
  seg($("themes"), themes.map((t) => [t, t[0].toUpperCase() + t.slice(1)]), state.theme, (t) => { state.theme = t; store.set("theme", t); render(); });
  seg($("modes"), MODES, state.mode, (m) => { state.mode = m; store.set("mode", m); render(); });
  $("changedOnly").checked = state.changedOnly;
  const mine = SHOTS.filter((s) => s.theme === state.theme);
  const changed = mine.filter((s) => s.status === "changed").length;
  const added = mine.filter((s) => s.status === "new").length;
  $("summary").textContent = LABEL + ": " + changed + " of " + mine.length + " changed" + (added ? ", " + added + " new" : "");
}

function renderList() {
  const nav = $("list");
  nav.innerHTML = "";
  const shots = visible();
  if (!shots.some((s) => s.file === state.file)) state.file = shots[0]?.file ?? null;
  let lastGroup = null;
  for (const s of shots) {
    if (s.group !== lastGroup) {
      const h = document.createElement("h2"); h.textContent = s.group; nav.appendChild(h); lastGroup = s.group;
    }
    const b = document.createElement("button");
    b.type = "button"; b.className = "shot";
    b.setAttribute("aria-current", String(s.file === state.file));
    b.innerHTML = '<span class="dot ' + s.status + '" title="' + s.status + '"></span><span class="name"></span>';
    b.querySelector(".name").textContent = s.title;
    b.onclick = () => { state.file = s.file; store.set("file", s.file); state.flipped = false; render(); };
    nav.appendChild(b);
  }
  if (!shots.length) nav.innerHTML = '<p class="empty">Nothing changed in this theme.</p>';
}

function img(src, alt) {
  return src ? '<img src="' + src + '" alt="' + alt + '">' : '<div class="empty">Not captured</div>';
}

function renderStage() {
  const stage = $("stage");
  const s = visible().find((x) => x.file === state.file);
  if (!s) { stage.innerHTML = '<div class="empty">Pick a screenshot.</div>'; return; }
  const statusText = { same: "No pixel change", changed: "Changed", new: "New in after", missing: "Missing from after" }[s.status];
  const hint = state.mode === "flip" ? "Click the image or press <kbd>Space</kbd> to flip" :
    state.mode === "slider" ? "Drag across the image" : "<kbd>↑</kbd><kbd>↓</kbd> next shot · <kbd>1</kbd>–<kbd>4</kbd> mode";
  let body = "";
  if (state.mode === "side" || !s.before || !s.after) {
    const region = s.box ? '<span class="region" style="left:' + s.box.x + '%;top:' + s.box.y + '%;width:' + s.box.w + '%;height:' + s.box.h + '%"></span>' : "";
    body = '<div class="pair"><figure><figcaption>Before</figcaption>' + img(s.before, "Before: " + s.title) +
      '</figure><figure><figcaption>After' + (s.box ? " (changed area outlined)" : "") + '</figcaption><div class="after-wrap">' + img(s.after, "After: " + s.title) + region + "</div></figure></div>";
  } else if (state.mode === "slider") {
    body = '<div class="frame" id="frame" style="--split:' + state.split + '%">' + img(s.before, "Before") +
      '<div class="top">' + img(s.after, "After") + '</div><div class="handle"></div><span class="tag l">Before</span><span class="tag r">After</span></div>';
  } else if (state.mode === "flip") {
    const which = state.flipped ? "after" : "before";
    body = '<div class="frame" id="flip" role="button" tabindex="0" aria-label="Flip between before and after">' +
      img(s[which], which) + '<span class="tag l">' + (state.flipped ? "After" : "Before") + "</span></div>";
  } else {
    body = '<div class="frame diff">' + img(s.before, "Before") + '<div class="top">' + img(s.after, "After") +
      '</div><span class="tag l">Difference: unchanged pixels are black</span></div>';
  }
  stage.innerHTML = '<div class="stage-head"><h3></h3><span class="status ' + s.status + '">' + statusText +
    '</span><span class="hint">' + hint + "</span></div>" + body;
  stage.querySelector("h3").textContent = s.title;

  const frame = $("frame");
  if (frame) {
    const move = (e) => {
      const r = frame.getBoundingClientRect();
      state.split = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
      frame.style.setProperty("--split", state.split + "%");
    };
    frame.addEventListener("pointerdown", (e) => { frame.setPointerCapture(e.pointerId); move(e); });
    frame.addEventListener("pointermove", (e) => { if (e.buttons) move(e); });
  }
  const flip = $("flip");
  if (flip) flip.onclick = () => { state.flipped = !state.flipped; renderStage(); };
}

function render() { renderChrome(); renderList(); renderStage(); }

$("changedOnly").onchange = (e) => { state.changedOnly = e.target.checked; store.set("changedOnly", state.changedOnly ? "1" : "0"); render(); };
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input")) return;
  const shots = visible();
  const i = shots.findIndex((s) => s.file === state.file);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = shots[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) { state.file = next.file; store.set("file", next.file); state.flipped = false; render(); }
  } else if (/^[1-4]$/.test(e.key)) {
    state.mode = MODES[Number(e.key) - 1][0]; store.set("mode", state.mode); render();
  } else if (e.key === " " && state.mode === "flip") {
    e.preventDefault(); state.flipped = !state.flipped; renderStage();
  }
});
render();
</script>
</body>
</html>
`;

const out = path.join(root, "compare.html");
fs.writeFileSync(out, html);
const changed = shots.filter((s) => s.status === "changed").length;
console.log(`[compare] ${shots.length} shots, ${changed} changed → ${out}`);
}

/**
 * Downgrades byte-different but pixel-identical shots to "same" and records
 * the changed region (as % of the image) for the rest. Pixels count as changed
 * when their summed RGB delta exceeds 24, and a shot needs more than 8 of them,
 * which ignores antialiasing noise.
 */
async function pixelDiff(changed) {
  if (changed.length === 0) return;
  let chromium;
  try {
    ({ chromium } = require("@playwright/test"));
  } catch {
    console.warn("[compare] @playwright/test not available; falling back to byte comparison");
    return;
  }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const shot of changed) {
    const before = fs.readFileSync(shot._b).toString("base64");
    const after = fs.readFileSync(shot._a).toString("base64");
    const r = await page.evaluate(async ([b64a, b64b]) => {
      const load = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = "data:image/png;base64," + src; });
      const [ia, ib] = await Promise.all([load(b64a), load(b64b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { n: Infinity, size: true };
      const w = ia.width, h = ia.height;
      const read = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
      const da = read(ia), db = read(ib);
      let n = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const k = (y * w + x) * 4;
          if (Math.abs(da[k] - db[k]) + Math.abs(da[k + 1] - db[k + 1]) + Math.abs(da[k + 2] - db[k + 2]) > 24) {
            n++;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      return { n, box: n ? { x: (x0 / w) * 100, y: (y0 / h) * 100, w: ((x1 - x0 + 1) / w) * 100, h: ((y1 - y0 + 1) / h) * 100 } : null };
    }, [before, after]);
    if (r.size) continue;
    if (r.n <= 8) shot.status = "same";
    else shot.box = r.box;
  }
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
