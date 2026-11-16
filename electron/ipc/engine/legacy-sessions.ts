/**
 * Legacy session logs: where the retired harness and the native engine keep
 * them, bringing old history over on first touch, and removing the retired
 * copies when a session is deleted. (F5/B4: split out of
 * `electron/ipc/engine-bridge.ts`; no logic changes.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as electron from "electron";
import { importLegacySession } from "../../agent/session/legacy-import";

/** First native use of a session that only exists as a engine log: bring its history over. */
export async function adoptLegacySession(sessionId: string): Promise<void> {
  try {
    await importLegacySession(legacyRoot(), hostRoot(), sessionId);
  } catch (err) {
    console.warn(`[agent] legacy import skipped for ${sessionId}:`, err instanceof Error ? err.message : err);
  }
}

/** Where the retired engine harness kept its logs; read only to bring old history over. */
export function legacyRoot(): string {
  let base: string;
  try { base = electron.app.getPath("userData"); } catch { base = os.tmpdir(); }
  return path.join(base, "sessions");
}

/**
 * Remove retired-harness logs whose directory name matches, so a cleared or deleted session is not
 * re-imported on next touch. Looks one level below each project directory (`<root>/<project>/<id>`).
 * Best effort unless `strict`, which throws after trying every match if any of them couldn't be removed.
 */
export function removeLegacySessions(match: (name: string) => boolean, opts: { strict?: boolean } = {}): void {
  const root = legacyRoot();
  const failed: string[] = [];
  const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  // A folder that doesn't exist has nothing to remove; one that can't be read might still hold a log.
  const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === "ENOENT";
  let projects: string[];
  try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch (err) {
    if (opts.strict && !missing(err)) throw new Error(`Couldn't read the old session history (${describe(err)})`);
    return;
  }
  for (const project of projects) {
    let names: string[];
    try { names = fs.readdirSync(path.join(root, project)); }
    catch (err) { if (!missing(err)) failed.push(`${project}: ${describe(err)}`); continue; }
    for (const name of names) {
      if (!match(name)) continue;
      try { fs.rmSync(path.join(root, project, name), { recursive: true, force: true }); } catch (err) { failed.push(`${project}/${name}: ${describe(err)}`); }
    }
  }
  if (opts.strict && failed.length) throw new Error(`Couldn't remove the old session history (${failed.join("; ")})`);
}

/** Native session logs live beside the legacy ones; a missing Electron `app` (unit tests) falls back to tmp. */
export function hostRoot(): string {
  let base: string;
  try { base = electron.app.getPath("userData"); } catch { base = os.tmpdir(); }
  return path.join(base, "sessions-native");
}
