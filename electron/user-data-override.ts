/**
 * Test/QA isolation hook: CAIRN_USER_DATA_DIR (set by the Playwright Electron e2e
 * harness) points userData at a throwaway profile.
 *
 * This must stay main.ts's first import. Several modules read
 * `app.getPath("userData")` as they load, and imports run before main.ts's own
 * code, so setting the path any later leaves those modules on the real profile.
 */
import { app } from "electron";

if (process.env.CAIRN_USER_DATA_DIR) {
  app.setPath("userData", process.env.CAIRN_USER_DATA_DIR);
}
