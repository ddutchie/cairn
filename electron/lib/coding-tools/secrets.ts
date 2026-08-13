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

/**
 * Bash commands that only manipulate env VARIABLES — never secret files
 * (`printenv` / `env` read variables; `export` / `unset` / `declare` set them).
 */
const ENV_VAR_OPS = /^(printenv|env|export|unset|declare|readonly)\b/;

/**
 * True when a bash command references a secret-bearing file (e.g. `cat .env`,
 * `grep KEY .env`, `cat ~/.aws/credentials`, `cat $PWD/.npmrc`). A conservative
 * heuristic — it may also flag harmless-but-rare commands like `ls .env` or
 * `find -name "*.env"`, which is the intended "block it for now" behaviour.
 * Pure env-VARIABLE operations are exempt.
 */
export function bashReferencesSecretFile(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (ENV_VAR_OPS.test(trimmed)) return false;
  // Split on shell metacharacters/quotes and check each token as a path.
  // `~`/`$` expansions and glob chars are stripped so `~/.npmrc` and
  // `$PWD/.env` still match, while `$FOO` (a variable deref) does not.
  const tokens = trimmed.split(/[\s"'`<>|;&()]+/).filter(Boolean);
  return tokens.some((tok) => {
    const cleaned = tok.replace(/^[~$]+/, "").replace(/[?*[\]]/g, "");
    return isSecretFile(cleaned) || isSecretFile(tok);
  });
}

/** Throw when a bash command reads/writes secret files. */
export function assertCommandNotReadingSecrets(command: string): void {
  if (bashReferencesSecretFile(command)) {
    throw new Error(
      "Refused: this command touches a protected secrets/credentials file. The agent " +
      "cannot read or write secrets automatically — ask the user to grant access if needed.",
    );
  }
}
