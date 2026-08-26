/**
 * Cairn — per-ask nonce store
 *
 * Shared by tool-approval and question flows. Nonces are minted main-side
 * when the ask is emitted, sent to the renderer in the push event, and
 * required on the respond IPC. This prevents a renderer-side script that
 * only saw the callId from approving/answering silently.
 */
import { randomBytes } from "node:crypto";

const pendingAskNonces = new Map<string, string>();

function nonceKey(sessionId: string, callId: string): string {
  return `${sessionId}::${callId}`;
}

export function mintAskNonce(sessionId: string, callId: string): string {
  const nonce = randomBytes(16).toString("hex");
  pendingAskNonces.set(nonceKey(sessionId, callId), nonce);
  return nonce;
}

export function verifyAskNonce(sessionId: string, callId: string, presented: unknown): boolean {
  const expected = pendingAskNonces.get(nonceKey(sessionId, callId));
  return typeof presented === "string" && expected !== undefined && presented === expected;
}

export function dropAskNonce(sessionId: string, callId: string): void {
  pendingAskNonces.delete(nonceKey(sessionId, callId));
}

export function clearAskNoncesForSession(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const k of Array.from(pendingAskNonces.keys())) {
    if (k.startsWith(prefix)) pendingAskNonces.delete(k);
  }
}

export function getAskNonce(sessionId: string, callId: string): string | undefined {
  return pendingAskNonces.get(nonceKey(sessionId, callId));
}
