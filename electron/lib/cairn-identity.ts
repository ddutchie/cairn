/**
 * Cairn — app identity for provider attribution.
 *
 * Centralises the `User-Agent` product/version/url so the DSH harness
 * (dsh-llm) and Cairn's direct `fetch` paths send the same `cairn/<version> (+https://github.com/ddutchie/cairn)` string.
 * Version is read at runtime from the app's `package.json` via `app.getAppPath()` (Electron, dev + prod)
 * with a `process.cwd()` fallback for Vitest/standalone.
 */

import * as fs from "fs";
import * as path from "path";

function getCairnVersion(): string {
  try {
    // Electron main path — works in dev (app.getAppPath() → repo root) and prod (→ app.asar)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as { app?: { getAppPath?: () => string; getVersion?: () => string } };
    if (app?.getAppPath) {
      const pkgPath = path.join(app.getAppPath(), "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
    if (app?.getVersion) {
      const v = app.getVersion();
      if (v && v !== "0.0.0") return v;
    }
  } catch {
    // not in Electron, or app not ready yet
  }
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch {
    // ignore
  }
  return "3.0.1";
}

const version = getCairnVersion();

export const CAIRN_USER_AGENT = `cairn/${version} (+https://github.com/ddutchie/cairn)`;

export const CAIRN_APP_IDENTITY = {
  product: "cairn",
  version,
  url: "https://github.com/ddutchie/cairn",
} as const;
