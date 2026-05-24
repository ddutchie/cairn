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
    tsfmModule = await import("tsfm-sdk");
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
 * Call Apple Foundation Model chat completions (non-streaming, supports tools).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callAppleFMChat(messages: OpenAIMessage[], tools?: any[]): Promise<any> {
  const client = await getClient();
  // Filter out any custom tools metadata that Apple FM doesn't need or like, or format it
  const formattedTools = tools?.map(t => {
    // Ensure we follow standard chat tool formats
    return {
      type: "function",
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }
    };
  });

  return await client.chat.completions.create({
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
    })),
    tools: formattedTools && formattedTools.length > 0 ? formattedTools : undefined,
    stream: false
  });
}

/**
 * Stream Apple Foundation Model chat completions (yields chunks).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function* streamAppleFMChat(messages: OpenAIMessage[], tools?: any[]): AsyncGenerator<any> {
  const client = await getClient();
  const formattedTools = tools?.map(t => {
    return {
      type: "function",
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }
    };
  });

  const stream = await client.chat.completions.create({
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
    })),
    tools: formattedTools && formattedTools.length > 0 ? formattedTools : undefined,
    stream: true
  });

  for await (const chunk of stream) {
    yield chunk;
  }
}
