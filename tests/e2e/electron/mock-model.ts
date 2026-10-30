/**
 * A scripted OpenAI-compatible model for deterministic agent e2e: when a turn starts it
 * calls the tool the test chose, and once it sees the tool result it answers with text.
 * No real model, no network beyond localhost.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface ToolPlan { name: string; args: Record<string, unknown> }
interface ChatMessage { role: string; content?: unknown; tool_calls?: unknown }
export interface RecordedRequest { messages: ChatMessage[]; hasTools: boolean }

export interface MockModel {
  baseUrl: string;
  /** What the next agent turn should do: call this tool (then answer), or just answer with `text`. */
  plan: ToolPlan | { text: string };
  requests: RecordedRequest[];
  /** The content of the most recent tool message the model was shown. */
  lastToolResult(): string | undefined;
  close(): Promise<void>;
}

const textOf = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? "").join("") : "";

function sse(res: http.ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const base = { id: "mock-1", object: "chat.completion.chunk", created: 0, model: "mock" };
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

export async function startMockModel(): Promise<MockModel> {
  const requests: RecordedRequest[] = [];
  let callSeq = 0;
  const mock: MockModel = {
    baseUrl: "",
    plan: { text: "ok" },
    requests,
    lastToolResult() {
      for (const r of [...requests].reverse()) {
        const tool = [...r.messages].reverse().find((m) => m.role === "tool");
        if (tool) return textOf(tool.content);
      }
      return undefined;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: ChatMessage[]; tools?: unknown[] };
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      requests.push({ messages: body.messages, hasTools });
      const last = body.messages[body.messages.length - 1];
      const answer = (text: string) => sse(res, [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ]);
      // Anything that isn't an agent turn (titles, summaries) just gets a short text.
      if (!hasTools) return answer("Mock title");
      const plan = mock.plan;
      if ("text" in plan || last?.role === "tool") {
        return answer("text" in plan ? plan.text : `Tool said: ${textOf(last.content).slice(0, 400)}`);
      }
      const id = `call_${++callSeq}`;
      sse(res, [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id, type: "function", function: { name: plan.name, arguments: "" } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(plan.args) } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
      ]);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mock.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return mock;
}
