import { Type } from "@earendil-works/pi-ai";
import type { ToolOutput } from "../tools";

/** Wrap a plain JSON Schema (from zod or an MCP server) as a tool parameter schema. */
export const fromJsonSchema = (json: Record<string, unknown>) => Type.Unsafe<Record<string, unknown>>(json);

/** Normalize any tool return value to model-readable text. */
export function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  const text = JSON.stringify(value);
  return text === undefined ? "null" : text;
}

export const ok = (content: string): ToolOutput => ({ content });
export const fail = (message: string): ToolOutput => ({ content: message, isError: true });

/** Cap long output keeping head and tail, which is where commands put their errors. */
export function clampMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… [${text.length - max} chars omitted] …\n${text.slice(text.length - half)}`;
}
