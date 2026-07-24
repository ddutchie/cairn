/**
 * Re-export of the shared external-reference extractor.
 *
 * The implementation now lives in `shared/chat/external-ref.ts` so both the
 * Electron desktop app and the Expo mobile app derive a linkable artefact from
 * an MCP/HTTP-service tool result the same way (https-guarded). This thin shim
 * keeps the existing `electron/lib/external-ref` import path working.
 */

export {
  extractExternalRef,
  extractExternalRefs,
  isHttpUrl,
  type ExternalRef,
} from "../../shared/chat/external-ref";
