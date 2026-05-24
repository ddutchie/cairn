/**
 * Cairn — Apple Foundation Models Integration
 * 
 * Provides on-device LLM inference using the Apple Foundation Models framework
 * via tsfm-sdk. Safely handles platforms and hardware checks to prevent crashes.
 */

import { OpenAIMessage } from "./llm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tsfmModule: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let compatModule: any = null;
let loadingTried = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modelInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let clientInstance: any = null;

/**
 * Safely dynamic-import tsfm-sdk and its compat layer.
 */
async function loadTsfm() {
  if (loadingTried) return tsfmModule;
  loadingTried = true;
  try {
    // Dynamic import to prevent crash on non-macOS/non-Arm64 during boot
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    tsfmModule = await import("tsfm-sdk");
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    compatModule = await import("tsfm-sdk/chat");
    return tsfmModule;
  } catch (err) {
    console.warn("tsfm-sdk is not available or failed to load:", err);
    return null;
  }
}

/**
 * Check if Apple Intelligence / Apple Foundation Models are supported and ready on this hardware.
 */
export async function isAppleFMAvailable(): Promise<{ available: boolean; reason?: string }> {
  if (process.platform !== "darwin") {
    return { available: false, reason: "Unsupported platform (Apple Intelligence requires macOS)." };
  }

  const tsfm = await loadTsfm();
  if (!tsfm) {
    return { available: false, reason: "On-device Foundation Models SDK failed to load." };
  }

  try {
    if (!modelInstance) {
      modelInstance = new tsfm.SystemLanguageModel();
    }
    const status = modelInstance.isAvailable();
    if (!status.available) {
      let reason = "Apple Intelligence model is not ready.";
      // Map availability reason codes from tsfm-sdk enum
      if (status.reason === tsfm.SystemLanguageModelUnavailableReason.APPLE_INTELLIGENCE_NOT_ENABLED) {
        reason = "Apple Intelligence is disabled. Please enable it in macOS System Settings.";
      } else if (status.reason === tsfm.SystemLanguageModelUnavailableReason.DEVICE_NOT_ELIGIBLE) {
        reason = "This device is not eligible (Apple Intelligence requires an Apple Silicon M-series chip or later).";
      } else if (status.reason === tsfm.SystemLanguageModelUnavailableReason.MODEL_NOT_READY) {
        reason = "Apple Intelligence model is downloading or warming up. Please wait.";
      }
      return { available: false, reason };
    }
    return { available: true };
  } catch (err) {
    console.error("Apple FM availability check threw an error:", err);
    return { available: false, reason: `Failed to check availability: ${String(err)}` };
  }
}

/**
 * Get or create the singleton OpenAI-compatible tsfm compat Client.
 */
async function getClient() {
  await loadTsfm();
  if (!compatModule) {
    throw new Error("Apple Intelligence compatibility client could not be loaded.");
  }
  if (!clientInstance) {
    clientInstance = new compatModule.default();
  }
  return clientInstance;
}

/**
 * Recursively sanitizes JSON schemas to meet Apple Foundation Models' native constraints.
 * Removes empty/invalid additionalProperties objects that trigger NSCocoaErrorDomain:4864 decoder rejects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeSchema(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitizeSchema);
  }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "additionalProperties" && value && typeof value === "object" && !Array.isArray(value)) {
      const valKeys = Object.keys(value);
      const hasValidKeys = valKeys.some(k => ["type", "const", "$ref", "anyOf"].includes(k));
      if (!hasValidKeys) {
        // Skip empty or invalid additionalProperties objects to satisfy Apple native schema parser
        continue;
      }
    }
    result[key] = sanitizeSchema(value);
  }
  return result;
}

export const APPLE_FM_ALLOWED_TOOLS = new Set<string>([
  "get_active_context",
  "get_note",
  "search_notes",
  "ensure_note",
  "append_to_note",
  "patch_note",
  "get_task",
  "search_tasks",
  "create_task",
  "update_task",
  "link_note_to_task",
  "get_knowledge_graph",
  "get_neighbors",
  "create_tag",
  "suggest_connections",
  "ask_questions"
]);

/**
 * Sanitize and format tools for the Apple Foundation Models compat client.
 * Unifies duplicate parameter names to share the same schema, preventing tsfm-sdk conflicts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAndSanitizeTools(tools?: any[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  // Filter tools to only include whitelisted core features for on-device chat
  const filtered = tools.filter(t => APPLE_FM_ALLOWED_TOOLS.has(t.function.name));
  if (filtered.length === 0) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seenParams = new Map<string, any>();
  return filtered.map(t => {
    let parameters = JSON.parse(JSON.stringify(t.function.parameters ?? {}));
    parameters = sanitizeSchema(parameters);

    if (parameters.properties) {
      for (const [key, value] of Object.entries(parameters.properties)) {
        if (seenParams.has(key)) {
          parameters.properties[key] = seenParams.get(key);
        } else {
          seenParams.set(key, value);
        }
      }
    }
    return {
      type: "function",
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters
      }
    };
  });
}

/**
 * Call Apple Foundation Model chat completions (non-streaming, supports tools).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callAppleFMChat(messages: OpenAIMessage[], tools?: any[]): Promise<any> {
  const client = await getClient();
  const formattedTools = formatAndSanitizeTools(tools);

  return await client.chat.completions.create({
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
    })),
    tools: formattedTools,
    stream: false
  });
}

/**
 * Stream Apple Foundation Model chat completions (yields chunks).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function* streamAppleFMChat(messages: OpenAIMessage[], tools?: any[]): AsyncGenerator<any> {
  const client = await getClient();
  const formattedTools = formatAndSanitizeTools(tools);

  const stream = await client.chat.completions.create({
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
    })),
    tools: formattedTools,
    stream: true
  });

  for await (const chunk of stream) {
    yield chunk;
  }
}
