import type { EmbedTask } from "./types";

export function withTaskPrefix(task: EmbedTask, text: string): string {
  switch (task) {
    case "search_query":
      return `Represent this sentence for searching relevant passages: ${text}`;
    case "search_document":
    case "clustering":
    default:
      return text;
  }
}
