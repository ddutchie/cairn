/**
 * AI Tool Builder — system prompt + internal tool definitions.
 *
 * These tools are dispatched LOCALLY by electron/ipc/tool-builder.ts (not the
 * general chat executor). The prompt orchestrates a classify → probe → discover
 * → optimize → finalize flow and enforces the secret-placeholder rule.
 */

export interface BuilderToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const BUILDER_TOOL_DEFS: BuilderToolDef[] = [
  {
    type: "function",
    function: {
      name: "probe_endpoint",
      description:
        "Make a real HTTP request to an endpoint and inspect the response. Returns status, contentType, a truncated bodySample, recursively-extracted jsonKeys (results/items-aware), and an authHint when the request looks unauthorized. Probe unauthenticated FIRST; only add headers once you know the auth scheme. Use secret PLACEHOLDERS (e.g. \"Bearer <API_KEY>\") in headers — never real secrets.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full endpoint URL." },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "HTTP method." },
          headers: {
            type: "object",
            description: "Optional headers. Secret values must use placeholders like <API_KEY>.",
            additionalProperties: { type: "string" },
          },
          query: { type: "object", description: "Query params for GET/DELETE.", additionalProperties: true },
          body: { type: "object", description: "JSON body for POST/PUT.", additionalProperties: true },
        },
        required: ["url", "method"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_response_keys",
      description:
        "Analyze a JSON response sample and suggest a trimmed responseKeys allow-list (dropping noisy keys like success/status/version), with a before/after token estimate. Use this on a successful probe's response to minimise tokens sent to the model at call time.",
      parameters: {
        type: "object",
        properties: {
          jsonSample: { description: "The JSON response (object or stringified)." },
        },
        required: ["jsonSample"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finalize_service",
      description:
        "Validate and SAVE (disabled) a custom HTTP Service tool. Headers carrying secrets MUST use placeholders; the app stores the real value securely and substitutes at call time. Call this once the endpoint is confirmed working and responseKeys are chosen.",
      parameters: {
        type: "object",
        properties: {
          definition: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              apiUrl: { type: "string" },
              method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
              headers: { type: "object", additionalProperties: { type: "string" } },
              toolDefinition: {
                type: "string",
                description: "Stringified OpenAI tool JSON: {name, description, parameters}.",
              },
              responseKeys: { type: "array", items: { type: "string" } },
              apiKeyUrl: { type: "string", description: "Where the user obtains an API key." },
            },
            required: ["name", "apiUrl", "method", "toolDefinition"],
          },
        },
        required: ["definition"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finalize_mcp",
      description:
        "Validate and SAVE (disabled) a remote MCP server tool (SSE or streamable-HTTP). Headers carrying secrets MUST use placeholders. Call this when the target is an MCP server rather than a plain REST API.",
      parameters: {
        type: "object",
        properties: {
          definition: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              baseUrl: { type: "string" },
              transport: { type: "string", enum: ["sse", "http"] },
              headers: { type: "object", additionalProperties: { type: "string" } },
            },
            required: ["name", "baseUrl"],
          },
        },
        required: ["definition"],
      },
    },
  },
];

export function buildBuilderSystemPrompt(): string {
  return `You are Cairn's AI Tool Builder. Your job: from a user's natural-language description plus an endpoint URL, produce a TESTED, token-optimized external tool — either a custom HTTP **Service** (REST/JSON API) or a remote **MCP server** — and save it.

## Flow
1. **Classify.** Decide Service (REST/JSON) vs MCP server (URL ends in /sse or /mcp, or a known MCP host). Ask the user only if genuinely ambiguous.
2. **Probe unauthenticated first** with \`probe_endpoint\`. Inspect status, bodySample, jsonKeys.
3. **Handle auth.** If the probe returns 401/403, read \`authHint\` and ask the user for ONLY the specific secret needed (and where it goes: header name + scheme, or query param). When you re-probe, put a secret PLACEHOLDER like \`<API_KEY>\` in the header value — the app injects the user's real value out of band. NEVER ask the model to handle the raw secret.
4. **Discover the tool shape.** Infer a concise \`toolDefinition\` (name, description, JSON-schema parameters) from the user's intent and the endpoint's required params. Probe once with realistic params to confirm a 2xx + JSON.
5. **Optimize.** Call \`suggest_response_keys\` on a successful response; tell the user the trimmed keys and token savings; let them adjust.
6. **Finalize.** Call \`finalize_service\` (or \`finalize_mcp\`) with the assembled definition. The tool is saved DISABLED; the user reviews, fills any secret, and enables it.

## Rules
- Secrets: headers carrying credentials use placeholders only (\`<API_KEY>\`, \`<TOKEN>\`, \`<ACCESS_TOKEN>\`, \`YOUR_API_KEY\`).
- Keep \`toolDefinition.parameters\` minimal — only what the endpoint actually needs.
- Prefer GET for read-only APIs; arguments become query params (GET/DELETE) or a JSON body (POST/PUT).
- Be concise in your messages to the user. Explain what you're probing and why, surface the host you're calling, and confirm before any authed probe.
- When done, finish with a one-line summary of the saved tool and that it's disabled pending the user's review.`;
}
