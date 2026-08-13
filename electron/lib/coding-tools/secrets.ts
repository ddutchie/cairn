/**
 * Secret-file guard for the coding agent's file tools.
 *
 * The agent must not read or write secret-bearing files (`.env*`, private keys,
 * credentials) — leaking them into the transcript leaks secrets to the model
 * (and a future model/export). This only guards the AGENT's structured tools
 * (`read` / `write` / `edit` / `grep`); the user-facing editor goes through
 * separate IPC handlers and can still open and edit these files.
 *
 * Note: `bash` is a general shell and is intentionally NOT guarded here — any
 * path filter is trivially bypassed (and `printenv` reads variables, not
 * files). Disabling the bash tool is the right control for that surface.
 */

import path from "path";

/** Match secret-bearing filenames (case-insensitive). */
const SECRET_NAME =
  /\.env(\.|$)|\.(pem|key|p12|pfx|p8)$|^id_(rsa|ed25519|ecdsa|dsa)$|\.npmrc$|\.netrc$|credentials\.json$/i;

/** Env TEMPLATES are safe to read (placeholder values, no real secrets). */
const NON_SECRET_ENV = /\.env\.(example|sample|template)(\.|$)/i;

/** True when the (absolute) file path points at a secret-bearing file. */
export function isSecretFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (NON_SECRET_ENV.test(base)) return false;
  if (SECRET_NAME.test(base)) return true;
  // .aws/credentials lives inside a directory — check the parent segment too.
  const normalized = filePath.replace(/[\\/]+/g, "/");
  return /\.aws\/credentials$/i.test(normalized);
}

/** Throw a refusal message for a secret file (kept vague — no path echoed). */
export function assertNotSecretFile(filePath: string): void {
  if (isSecretFile(filePath)) {
    throw new Error("Refused: this file is protected (secrets/credentials) and cannot be accessed by the agent.");
  }
}
