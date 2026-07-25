/**
 * Re-export of the shared tolerant tool-args parser.
 *
 * The implementation now lives in `shared/chat/parse-tool-args.ts` so both the
 * Electron desktop app and the Expo mobile app parse LLM tool-call arguments the
 * same way (strict-first, lossless-repair, never a silent `{}`). This thin
 * shim keeps the existing `electron/lib/parse-tool-args` import path working.
 */

export { parseToolArgs, type ParseToolArgsResult } from "../../shared/chat/parse-tool-args";
