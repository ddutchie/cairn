/**
 * LLM utility helpers shared across the Electron main process.
 */

/** Returns true if the given base URL points to a local server. */
export function isLocalEndpoint(baseUrl: string): boolean {
  return (
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("0.0.0.0")
  );
}

export interface LLMConfig { baseUrl: string; model: string; apiKey: string; }

export async function callLLM(config: LLMConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4096,
      temperature: 0.4,
    }),
  });
  if (!response.ok) throw new Error(`LLM error ${response.status}: ${await response.text().catch(() => response.statusText)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await response.json() as any;
  return (data.choices?.[0]?.message?.content as string) ?? "";
}
