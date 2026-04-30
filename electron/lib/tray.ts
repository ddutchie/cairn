/**
 * Cairn — System tray setup
 *
 * Creates the menu bar / system tray icon, badge, and context menu.
 * Returns an `updateBadge` function the caller can use to push new unread counts.
 */

import { app, Tray, Menu, nativeImage, BrowserWindow } from "electron";
import path from "path";

const isDev = !app.isPackaged;

export interface TrayHandle {
  tray: Tray;
  updateBadge: (count: number) => void;
}

export function createTray(win: BrowserWindow): TrayHandle {
  const trayIconDir = isDev
    ? path.join(__dirname, "..", "..", "public")
    : path.join(process.resourcesPath, "app.asar", "out");

  let trayImage: ReturnType<typeof nativeImage.createFromPath>;
  if (process.platform === "darwin") {
    const templatePath = path.join(trayIconDir, "trayTemplate.png");
    trayImage = nativeImage.createFromPath(templatePath);
    trayImage.setTemplateImage(true);
  } else if (process.platform === "win32") {
    // Use .ico on Windows — it embeds 16/32/48 px sizes so the tray icon stays
    // sharp at 100%, 125%, and 150% DPI scaling (common on laptop displays).
    const iconPath = path.join(trayIconDir, "tray.ico");
    trayImage = nativeImage.createFromPath(iconPath);
  } else {
    const iconPath = path.join(trayIconDir, "icon.png");
    trayImage = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  }

  const tray = new Tray(trayImage);
  tray.setToolTip("Cairn");

  function buildMenu(unreadCount: number) {
    return Menu.buildFromTemplate([
      {
        label: unreadCount > 0
          ? `${unreadCount} unread MCP update${unreadCount > 1 ? "s" : ""}`
          : "No new MCP updates",
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Open Cairn",
        click: () => { win.show(); win.focus(); },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]);
  }

  tray.setContextMenu(buildMenu(0));

  tray.on("click", () => { win.show(); win.focus(); });

  function updateBadge(count: number) {
    tray.setContextMenu(buildMenu(count));
    if (process.platform === "darwin") {
      app.setBadgeCount(count);
    }
    if (!win.isDestroyed()) {
      win.webContents.send("mcp:unread-count", count);
    }
  }

  return { tray, updateBadge };
}
