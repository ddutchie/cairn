---
title: ArchWiz — Electron Process
tags:
  - archwiz
  - architecture
  - electron
---

# Electron Process

[[ArchWiz/Overview|Back to Overview]]

## Main Process — electron/main.ts

Thin orchestrator. Responsibilities:

- Enforces a **single-instance lock**
- On `app.whenReady`, calls three `register*` IPC setup functions then `createWindow`
- Handles `window-all-closed` and `activate`

## Window Factory — electron/window.ts

Creates a `BrowserWindow` with:

- Size: **1200 × 800**, `hiddenInset` titlebar
- Security: `contextIsolation: true`, `nodeIntegration: false`
