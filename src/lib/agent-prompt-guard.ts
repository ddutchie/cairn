/**
 * Backwards-compatibility shim — the session prompt guard lives in
 * `@/store/slices/session-prompt-guard` now (store layer owns session
 * lifecycle). Import from there in new code.
 */

export {
  hasPromptFired,
  markPromptFired,
  forgetSessionPrompts,
} from "@/store/slices/session-prompt-guard";
