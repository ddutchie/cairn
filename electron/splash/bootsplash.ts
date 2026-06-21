/**
 * Cairn — Boot splash screen
 *
 * Shows a branded splash window immediately on app launch, before the main
 * window is created. The splash displays progress for:
 *
 *   1. Update check (prod only — skipped in dev)
 *   2. DB migration (workspace-level migrations)
 *   3. Embeddings reindex (if model changed)
 *   4. Notes sync (recover notes on disk missing from SQLite)
 *
 * When all steps complete, the caller destroys the splash and creates the
 * main window. This replaces the old approach of showing ReindexModal and
 * MigrationModal as overlays after the main window loaded.
 *
 * The HTML is embedded as a string literal so esbuild bundles it into
 * main.js — no external file to copy. The Cairn icon is loaded at runtime
 * from the Next.js static export (`out/icon.png`, RGBA with transparency)
 * and embedded as a base64 data URL.
 */
import { app, BrowserWindow } from "electron";
import * as fs from "fs";
import * as path from "path";

export type SplashStep =
  | "update"
  | "migrations"
  | "reindex"
  | "notes-sync"
  | "done";

export interface SplashProgress {
  step: SplashStep;
  label: string;
  detail?: string;
  pct: number;
}

const SPLASH_WIDTH = 400;
const SPLASH_HEIGHT = 480;

/**
 * Load the Cairn icon from the Next.js static export. It has transparency
 * (RGBA) so it renders cleanly on both dark and light splash backgrounds.
 * Tries the `out/` directory (served by `app://` in prod, source in dev)
 * with a fallback to `build-resources/` from the source tree.
 */
function getIconDataUrl(): string | null {
  const outDir = path.join(__dirname, "..", "out");
  const candidates = [
    path.join(outDir, "icon.png"),
    path.join(outDir, "icon_tray.png"),
    path.join(__dirname, "..", "build-resources", "icon.png"),
    path.join(__dirname, "icon.png"),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p);
        return "data:image/png;base64," + buf.toString("base64");
      }
    } catch {
      // try next
    }
  }
  return null;
}

function getAppVersion(): string {
  // `NEXT_PUBLIC_APP_VERSION` (used in Settings) is a Next.js build-time
  // injection — only available in the renderer, not in the main process.
  // `app.getVersion()` works in prod but returns the Electron binary's
  // version (e.g. 41.8.0) in dev. Reading package.json via `app.getAppPath()`
  // works in both — it returns the app root where package.json lives,
  // sourced from the same file next.config.ts reads at build time.
  try {
    const pkgPath = path.join(app.getAppPath(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version;
  } catch {
    try {
      return app.getVersion();
    } catch {
      return "";
    }
  }
}

function buildSplashHtml(iconDataUrl: string | null): string {
  const version = getAppVersion();
  const logoHtml = iconDataUrl
    ? `<img src="${iconDataUrl}" width="64" height="64" alt="Cairn" />`
    : `<div style="width:64px;height:64px;border-radius:12px;background:var(--splash-accent);display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:700;color:var(--splash-background);">C</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cairn</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    height: 100%; width: 100%;
    overflow: hidden;
    -webkit-user-select: none; user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  body {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 48px 32px;
    --splash-text: #e8e8e8;
    --splash-text-dim: #666;
    --splash-accent: #8b7bd8;
    --splash-progress-bg: #222;
    --splash-success: #22c55e;
    --splash-error: #ef4444;
    --splash-background: #0d0d0d;
  }
  .logo {
    width: 64px; height: 64px;
    margin-bottom: 20px;
    display: flex; align-items: center; justify-content: center;
  }
  .logo img {
    width: 64px; height: 64px;
    -webkit-user-drag: none;
  }
  .title {
    font-size: 1.25rem; font-weight: 600;
    color: var(--splash-text);
    letter-spacing: -0.02em;
    margin-bottom: 4px;
  }
  .subtitle {
    font-size: 0.75rem; font-weight: 400;
    color: var(--splash-text-dim);
    margin-bottom: 36px;
  }
  .step-container {
    width: 100%;
    max-width: 280px;
    display: flex; flex-direction: column;
    align-items: center;
  }
  #step-label {
    font-size: 0.8rem; font-weight: 500;
    color: var(--splash-text);
    margin-bottom: 8px;
    text-align: center;
  }
  #step-detail {
    font-size: 0.6875rem; font-weight: 400;
    color: var(--splash-text-dim);
    text-align: center;
    height: 1.1rem;
    margin-bottom: 16px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .progress-track {
    width: 100%; height: 3px;
    border-radius: 2px;
    background: var(--splash-progress-bg);
    overflow: hidden;
  }
  .progress-fill {
    height: 100%; width: 0%;
    border-radius: 2px;
    background: var(--splash-accent);
    transition: width 300ms ease;
  }
  #spinner {
    width: 16px; height: 16px;
    margin-top: 24px;
    border: 2px solid var(--splash-text-dim);
    border-top-color: var(--splash-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  #spinner.hidden { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #error {
    font-size: 0.7rem; color: var(--splash-error);
    text-align: center; margin-top: 20px;
    max-width: 280px; word-wrap: break-word;
    display: none;
  }
  #done-list {
    width: 100%; max-width: 280px;
    margin-top: 20px;
  }
  .done-row {
    font-size: 0.7rem; color: var(--splash-text-dim);
    margin-top: 6px;
    display: flex; align-items: center;
    transition: opacity 300ms ease;
  }
  .done-row .checkmark {
    display: inline-block; width: 14px; height: 14px;
    margin-right: 8px; flex-shrink: 0;
  }
  .bottom-row {
    position: absolute; bottom: 24px; left: 0; right: 0;
    display: flex; justify-content: center; align-items: center;
    gap: 6px;
    font-size: 0.65rem; color: var(--splash-text-dim);
  }
  .bottom-row .dot {
    width: 2px; height: 2px; border-radius: 50%;
    background: var(--splash-text-dim); opacity: 0.6;
  }
</style>
</head>
<body>
  <div class="logo">${logoHtml}</div>
  <div class="title">Cairn</div>
  <div class="subtitle">Local-first notes &amp; projects</div>
  <div class="step-container">
    <div id="step-label">Starting…</div>
    <div id="step-detail"></div>
    <div class="progress-track">
      <div class="progress-fill" id="progress-fill"></div>
    </div>
    <div id="spinner"></div>
    <div id="error"></div>
    <div id="done-list"></div>
  </div>
  <div class="bottom-row">
    <span>v${version}</span>
    <span class="dot"></span>
    <span>cairn.app</span>
  </div>

<script>
  const { ipcRenderer } = require('electron');
  const labelEl = document.getElementById('step-label');
  const detailEl = document.getElementById('step-detail');
  const fillEl = document.getElementById('progress-fill');
  const spinnerEl = document.getElementById('spinner');
  const errorEl = document.getElementById('error');
  const doneListEl = document.getElementById('done-list');

  const doneSteps = [];

  // ── Ambient messages ────────────────────────────────────────────────
  // Shown while the real boot steps are instant (common in dev: no update,
  // no migrations, no reindex). Cycles through these with a slowly creeping
  // progress bar so the splash feels alive. When a real boot step fires
  // (via splash:progress), the ambient cycle stops and real progress takes
  // over.
  const ambientMessages = [
    'Initializing workspace',
    'Organizing thoughts',
    'Connecting ideas',
    'Warming up the knowledge graph',
    'Calibrating semantic search',
    'Loading workspace',
  ];
  var ambientIndex = 0;
  var ambientPct = 0;
  var ambientActive = true;
  var ambientTimer = null;

  function startAmbient() {
    ambientActive = true;
    labelEl.textContent = ambientMessages[0];
    ambientTimer = setInterval(function() {
      // Creep toward 95% — never reach 100% on ambient (that's reserved
      // for the "done" signal). Slows down as it approaches the cap so
      // it doesn't look stuck at 90%.
      var remaining = 95 - ambientPct;
      var increment = Math.max(0.5, remaining * 0.04 + Math.random() * 2);
      ambientPct = Math.min(ambientPct + increment, 95);
      fillEl.style.width = ambientPct + '%';
      if (ambientPct >= 25 && ambientIndex < 1) { ambientIndex = 1; labelEl.textContent = ambientMessages[1]; }
      else if (ambientPct >= 45 && ambientIndex < 2) { ambientIndex = 2; labelEl.textContent = ambientMessages[2]; }
      else if (ambientPct >= 60 && ambientIndex < 3) { ambientIndex = 3; labelEl.textContent = ambientMessages[3]; }
      else if (ambientPct >= 75 && ambientIndex < 4) { ambientIndex = 4; labelEl.textContent = ambientMessages[4]; }
      else if (ambientPct >= 88 && ambientIndex < 5) { ambientIndex = 5; labelEl.textContent = ambientMessages[5]; }
    }, 250);
  }

  function stopAmbient() {
    if (!ambientActive) return;
    ambientActive = false;
    if (ambientTimer) clearInterval(ambientTimer);
  }

  startAmbient();

  function addDoneStep(label) {
    if (doneSteps.includes(label)) return;
    doneSteps.push(label);
    var row = document.createElement('div');
    row.className = 'done-row';
    row.innerHTML = '<svg class="checkmark" viewBox="0 0 14 14"><path d="M2 7l3.5 3.5L12 3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' + label;
    doneListEl.appendChild(row);
  }

  ipcRenderer.on('splash:progress', function(_event, data) {
    errorEl.style.display = 'none';
    spinnerEl.classList.remove('hidden');

    // Real boot step — stop ambient cycle and use real progress.
    stopAmbient();

    if (data.step === 'done') {
      stopAmbient();
      labelEl.textContent = 'Ready';
      detailEl.textContent = '';
      spinnerEl.classList.add('hidden');
      // Smoothly fill the remaining gap to 100% using the CSS transition.
      fillEl.style.width = '100%';
      return;
    }

    labelEl.textContent = data.label || data.step;
    detailEl.textContent = data.detail || '';
    fillEl.style.width = (data.pct || 0) + '%';
  });

  ipcRenderer.on('splash:step-done', function(_event, data) {
    if (data.label) addDoneStep(data.label);
    // Don't reset to 0% — let ambient or next step drive the bar.
  });

  ipcRenderer.on('splash:error', function(_event, data) {
    stopAmbient();
    errorEl.textContent = data.message || 'An error occurred';
    errorEl.style.display = 'block';
    spinnerEl.classList.add('hidden');
    labelEl.textContent = 'Error';
    fillEl.style.width = '0%';
  });

  ipcRenderer.on('splash:theme', function(_event, data) {
    var root = document.documentElement;
    Object.keys(data).forEach(function(key) {
      root.style.setProperty('--splash-' + key, data[key]);
    });
    if (data.background) document.body.style.background = data.background;
  });
</script>
</body>
</html>`;
}

function getThemeColors(): Record<string, string> {
  try {
    const themeFile = path.join(app.getPath("userData"), "theme.json");
    if (fs.existsSync(themeFile)) {
      const t = JSON.parse(fs.readFileSync(themeFile, "utf8")).theme;
      if (t === "light") {
        return {
          text: "#1a1a1a",
          "text-dim": "#888",
          accent: "#6366f1",
          "progress-bg": "#e0e0e0",
          success: "#22c55e",
          error: "#ef4444",
          background: "#f5f4f1",
        };
      }
    }
  } catch {
    // ignore — use dark defaults
  }
  return {
    text: "#e8e8e8",
    "text-dim": "#666",
    accent: "#8b7bd8",
    "progress-bg": "#222",
    success: "#22c55e",
    error: "#ef4444",
    background: "#0d0d0d",
  };
}

export class BootSplash {
  private win: BrowserWindow | null = null;

  create(): void {
    const colors = getThemeColors();
    this.win = new BrowserWindow({
      width: SPLASH_WIDTH,
      height: SPLASH_HEIGHT,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      center: true,
      show: true,
      backgroundColor: colors.background,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
      },
    });

    this.win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(buildSplashHtml(getIconDataUrl())),
    );

    this.win.webContents.on("did-finish-load", () => {
      this.send("splash:theme", colors);
    });
  }

  progress(data: SplashProgress): void {
    this.send("splash:progress", data);
  }

  stepDone(label: string): void {
    this.send("splash:step-done", { label });
  }

  error(message: string): void {
    this.send("splash:error", { message });
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.close();
    }
    this.win = null;
  }

  private send(channel: string, data: unknown): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, data);
    }
  }
}
