/**
 * Test/QA isolation hook: CAIRN_USER_DATA_DIR (set by the Playwright Electron e2e
 * harness) points userData at a throwaway profile.
 *
 * This must stay main.ts's first import. Several modules read
 * `app.getPath("userData")` as they load, and imports run before main.ts's own
 * code, so setting the path any later leaves those modules on the real profile.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { app } from "electron";

if (process.env.CAIRN_USER_DATA_DIR) {
  // setPath needs an absolute path to a folder that exists. Owner-only, like Electron's own profile: it holds session logs.
  const dir = resolve(process.env.CAIRN_USER_DATA_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  app.setPath("userData", dir);
}
