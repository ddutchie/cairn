import type { NomicTask } from "./types";
import { NOMIC_MODEL_ID } from "./types";

export const NOMIC_PREFIX: Record<NomicTask, string> = {
  search_document: "search_document: ",
  search_query: "search_query: ",
  clustering: "clustering: ",
};

export function withNomicPrefix(task: NomicTask, text: string): string {
  return `${NOMIC_PREFIX[task]}${text}`;
}

export function taskForIndexing(): NomicTask {
  return "search_document";
}

export function taskForQuery(): NomicTask {
  return "search_query";
}

export function taskForClustering(): NomicTask {
  return "clustering";
}

export function defaultModelId(): string {
  return NOMIC_MODEL_ID;
}

export function normalizeModel(model: string | undefined | null): string {
  if (!model) return NOMIC_MODEL_ID;
  return model;
}
