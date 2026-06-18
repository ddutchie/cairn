/**
 * Cairn — IPC handlers for Mobile Access / LAN sync (`mobile:*` channels).
 *
 * Thin delegations to `electron/lib/mobile-server.ts`. The server itself owns
 * its own port + PIN auth + SSE broadcast; these handlers are the renderer's
 * control surface for it.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerIpcHandle, broadcastEvent } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as mobileServer from "../lib/mobile-server";

export function registerMobileHandlers(ctx: DbContext, userDataPath: string): void {
  registerIpcHandle("mobile:status", () => handle(() => {
    return mobileServer.getMobileStatus(userDataPath);
  }));

  registerIpcHandle("mobile:saveSettings", (_e, newSettings: Record<string, unknown>) => handle(async () => {
    const s = mobileServer.saveMobileSettings(userDataPath, newSettings);
    if (s.enabled) {
      mobileServer.startMobileServer(userDataPath, ctx);
    } else {
      mobileServer.stopMobileServer();
    }
    const status = await mobileServer.getMobileStatus(userDataPath);
    broadcastEvent("mobile:status-changed", status);
    return status;
  }));

  registerIpcHandle("mobile:regeneratePin", () => handle(async () => {
    const pin = Math.floor(1000 + Math.random() * 9000).toString();
    mobileServer.saveMobileSettings(userDataPath, { pin });
    const status = await mobileServer.getMobileStatus(userDataPath);
    broadcastEvent("mobile:status-changed", status);
    return status;
  }));
}
