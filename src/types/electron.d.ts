/**
 * Global type declaration for the Electron contextBridge API.
 * Gives the renderer full type safety on `window.electron`.
 */

import type { ElectronAPI } from "../../electron/preload";

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}
