/**
 * Shared byte-cap constant for coding tool output truncation.
 *
 * The truncation itself lives where it is enforced (e.g. `coding-tools/bash.ts`
 * streams and caps output locally); this module only pins the shared budget so
 * every tool agrees on one ceiling.
 */

export const DEFAULT_MAX_BYTES = 50_000;
