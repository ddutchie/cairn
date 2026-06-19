import type { NomicTask } from "./types";

export const NOMIC_PREFIX: Record<NomicTask, string> = {
  search_document: "search_document: ",
  search_query: "search_query: ",
  clustering: "clustering: ",
};

export function withNomicPrefix(task: NomicTask, text: string): string {
  return `${NOMIC_PREFIX[task]}${text}`;
}
