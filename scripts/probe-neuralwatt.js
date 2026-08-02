#!/usr/bin/env node
/**
 * Probe the NeuralWatt OpenAI-compatible endpoint and dump the raw response
 * so we can see exactly which fields it returns — especially `usage.cost`.
 *
 * Run: NEURALWATT_API_KEY=sk-... node scripts/probe-neuralwatt.js
 */
const BASE = "https://api.neuralwatt.com/v1";
const KEY = process.env.NEURALWATT_API_KEY;
if (!KEY) {
  console.error("Error: set NEURALWATT_API_KEY env var first.");
  process.exit(1);
}

async function probeModels() {
  console.log("=== GET /models ===");
  const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  console.log("status:", r.status);
  const text = await r.text();
  try {
    const json = JSON.parse(text);
    const ids = (json.data ?? []).map((m) => m.id);
    console.log("model ids:", ids);
  } catch {
    console.log("body:", text.slice(0, 500));
  }
}

async function probeKey() {
  console.log("=== GET /key ===");
  const r = await fetch(`${BASE}/key`, { headers: { Authorization: `Bearer ${KEY}` } });
  console.log("status:", r.status);
  console.log("body:", await r.text());
}

async function probeQuota() {
  console.log("\n=== GET /quota ===");
  const r = await fetch(`${BASE}/quota`, { headers: { Authorization: `Bearer ${KEY}` } });
  console.log("status:", r.status);
  console.log("body:", await r.text());
}

async function probeChatNonStreaming() {
  console.log("\n=== POST /chat/completions (non-streaming) ===");
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "glm-5.2-short",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 16,
      stream: false,
    }),
  });
  console.log("status:", r.status);
  const text = await r.text();
  try {
    const json = JSON.parse(text);
    console.log("usage:", JSON.stringify(json.usage, null, 2));
    console.log("cost (top-level):", JSON.stringify(json.cost, null, 2));
    console.log("energy (top-level):", JSON.stringify(json.energy, null, 2));
  } catch {
    console.log("body:", text);
  }
}

async function probeChatStreaming() {
  console.log("\n=== POST /chat/completions (streaming) ===");
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "glm-5.2-short",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 16,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  console.log("status:", r.status);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        console.log("  [DONE]");
        continue;
      }
      try {
        const chunk = JSON.parse(payload);
        if (chunk.usage) {
          console.log("  usage chunk:", JSON.stringify(chunk.usage, null, 2));
        }
        if (chunk.cost !== undefined) {
          console.log("  cost chunk (top-level):", JSON.stringify(chunk.cost, null, 2));
        }
        if (chunk.energy !== undefined) {
          console.log("  energy chunk (top-level):", JSON.stringify(chunk.energy, null, 2));
        }
        // Print any other top-level keys that aren't choices/usage/cost
        const otherKeys = Object.keys(chunk).filter(
          (k) => k !== "choices" && k !== "usage" && k !== "cost" && k !== "energy" && k !== "id" && k !== "object" && k !== "created" && k !== "model" && k !== "service_tier" && k !== "system_fingerprint"
        );
        if (otherKeys.length > 0) {
          console.log("  other keys:", otherKeys, "→", JSON.stringify(Object.fromEntries(otherKeys.map((k) => [k, chunk[k]]))));
        }
      } catch {
        console.log("  (unparseable SSE line)");
      }
    }
  }
}

(async () => {
  await probeModels();
  await probeKey();
  await probeQuota();
  await probeChatNonStreaming();
  await probeChatStreaming();
})().catch((e) => {
  console.error("Probe failed:", e);
  process.exit(1);
});
