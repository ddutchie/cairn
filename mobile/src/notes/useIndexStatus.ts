import { useSyncExternalStore } from "react";
import {
  subscribeIndexStatus,
  getIndexStatus,
  type IndexStatus,
} from "./embeddings";

/**
 * Subscribe to on-device semantic-index catch-up status (for the header
 * progress bar). Backed by an external store so it updates without polling.
 */
export function useIndexStatus(): IndexStatus {
  return useSyncExternalStore(subscribeIndexStatus, getIndexStatus, getIndexStatus);
}
