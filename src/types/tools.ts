/** External tools (MCP servers, custom HTTP services) and the community registry. */

// External tool definitions (MCP servers, services, attachments) live in shared/ so the
// IPC contract and the main process use the same shapes.
export * from "../../shared/types/tools";

// Community registry manifests live in shared/chat/registry-schema.ts (single source
// of truth, including the manifest parsers). This barrel re-exports them so
// existing `@/types` imports keep working; do not re-declare them here (F10).
export * from "../../shared/chat/registry-schema";

// Back-compat aliases for the previously named definition interfaces. Prefer
// `RegistryMcpEntry["definition"]`-style indexed access in new code.
import type {
  RegistryAutomationEntry,
  RegistryCommandEntry,
  RegistryMcpEntry,
  RegistryPersonalityEntry,
  RegistryProviderEntry,
  RegistryServiceEntry,
} from "../../shared/chat/registry-schema";
export type RegistryMcpDefinition = RegistryMcpEntry["definition"];
export type RegistryServiceDefinition = RegistryServiceEntry["definition"];
export type RegistryCommandDefinition = RegistryCommandEntry["definition"];
export type RegistryProviderDefinition = RegistryProviderEntry["definition"];
export type RegistryPersonalityDefinition = RegistryPersonalityEntry["definition"];
export type RegistryAutomationDefinition = RegistryAutomationEntry["definition"];
