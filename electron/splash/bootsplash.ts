/**
 * Cairn — Boot splash screen
 *
 * Shows a branded splash window immediately on app launch, before the main
 * window is created. Progress is driven entirely by real boot events from
 * main.ts and boot-sequence.ts — no ambient cycle, no fake progress.
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
  pct?: number;
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

function buildSplashHtml(iconDataUrl: string | null, colors: Record<string, string>): string {
  const version = getAppVersion();
  // Bake the resolved theme palette into the initial CSS so the splash paints
  // with the correct (light or dark) colors on first frame — no dark flash
  // before the post-load `splash:theme` IPC override arrives.
  const initialVars = Object.keys(colors)
    .map((key) => `    --splash-${key}: ${colors[key]};`)
    .join("\n");
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
  :root {
${initialVars}
  }
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
    background: var(--splash-background);
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

  function addDoneStep(label) {
    if (doneSteps.includes(label)) return;
    doneSteps.push(label);
    var row = document.createElement('div');
    row.className = 'done-row';
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'checkmark');
    svg.setAttribute('viewBox', '0 0 14 14');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M2 7l3.5 3.5L12 3');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    row.appendChild(svg);
    var span = document.createElement('span');
    span.textContent = label;
    row.appendChild(span);
    doneListEl.appendChild(row);
  }

  ipcRenderer.on('splash:progress', function(_event, data) {
    errorEl.style.display = 'none';
    spinnerEl.classList.remove('hidden');

    if (data.step === 'done') {
      labelEl.textContent = 'Ready';
      detailEl.textContent = '';
      spinnerEl.classList.add('hidden');
      // Smoothly fill the remaining gap to 100% using the CSS transition.
      fillEl.style.width = '100%';
      return;
    }

    labelEl.textContent = data.label || data.step;
    detailEl.textContent = data.detail || '';
    // Only update the progress bar when pct is explicitly provided. This
    // lets pre-boot events (main.ts) update the label without resetting
    // the bar to 0% before boot-sequence.ts takes over with real values.
    if (typeof data.pct === 'number') {
      fillEl.style.width = data.pct + '%';
    }
  });

  ipcRenderer.on('splash:step-done', function(_event, data) {
    if (data.label) addDoneStep(data.label);
  });

  ipcRenderer.on('splash:error', function(_event, data) {
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
  // Mirrors the app's real design tokens in src/app/globals.css so the splash
  // matches the window that follows it (light branch = [data-theme="light"]).
  const light: Record<string, string> = {
    text: "#1a1917",          // --text-primary (light)
    "text-dim": "#9e9a94",    // --text-tertiary (light)
    accent: "#6457e8",        // --accent (light)
    "progress-bg": "#f0eeeb", // --surface-2 (light)
    success: "#22c55e",
    error: "#ef4444",
    background: "#f5f4f1",    // --background (light)
  };
  const dark: Record<string, string> = {
    text: "#e8e4dc",          // --text-primary (dark)
    "text-dim": "#66635f",    // --text-tertiary (dark)
    accent: "#7c6af7",        // --accent (dark)
    "progress-bg": "#1a1a1a", // --surface-2 (dark)
    success: "#22c55e",
    error: "#ef4444",
    background: "#0d0d0d",    // --background (dark)
  };
  try {
    const themeFile = path.join(app.getPath("userData"), "theme.json");
    if (fs.existsSync(themeFile)) {
      const t = JSON.parse(fs.readFileSync(themeFile, "utf8")).theme;
      if (t === "light") return light;
    }
  } catch {
    // ignore — use dark defaults
  }
  return dark;
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
        encodeURIComponent(buildSplashHtml(getIconDataUrl(), colors)),
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
