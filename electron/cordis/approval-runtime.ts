import { randomBytes } from "node:crypto";
import { createPendingAskRegistry, type PendingAskMeta, type PendingAskRegistry } from "./approval-grants";

export type ApprovalDecision = { approved: boolean; grant?: "session" | "command" | "workspace" };
export type ApprovalResolver = (decision: ApprovalDecision) => void;

export const cordisPendingApprovals = new Map<string, ApprovalResolver>();
export const pendingKey = (sessionId: string, callId: string): string => `${sessionId}::${callId}`;
export const pendingAsks: PendingAskRegistry = createPendingAskRegistry();

const pendingAskNonces = new Map<string, string>();

export function mintAskNonce(sessionId: string, callId: string): string {
  const nonce = randomBytes(16).toString("hex");
  pendingAskNonces.set(pendingKey(sessionId, callId), nonce);
  return nonce;
}

export function verifyAskNonce(sessionId: string, callId: string, presented: unknown): boolean {
  const expected = pendingAskNonces.get(pendingKey(sessionId, callId));
  return typeof presented === "string" && expected !== undefined && presented === expected;
}

export function dropAskNonce(sessionId: string, callId: string): void {
  pendingAskNonces.delete(pendingKey(sessionId, callId));
}

export function clearAskNoncesForSession(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const key of Array.from(pendingAskNonces.keys())) {
    if (key.startsWith(prefix)) pendingAskNonces.delete(key);
  }
}

export function getAskNonce(sessionId: string, callId: string): string | undefined {
  return pendingAskNonces.get(pendingKey(sessionId, callId));
}

export function _debugNonceKeys(): string[] {
  return Array.from(pendingAskNonces.keys());
}

export function registerPendingApproval(sessionId: string, callId: string, resolve: ApprovalResolver): () => void {
  const key = pendingKey(sessionId, callId);
  cordisPendingApprovals.set(key, resolve);
  return () => cordisPendingApprovals.delete(key);
}

export function getPendingApproval(sessionId: string, callId: string): ApprovalResolver | undefined {
  return cordisPendingApprovals.get(pendingKey(sessionId, callId));
}

export function resolvePendingApproval(sessionId: string, callId: string, decision: ApprovalDecision): boolean {
  const key = pendingKey(sessionId, callId);
  const resolver = cordisPendingApprovals.get(key);
  if (!resolver) return false;
  resolver(decision);
  cordisPendingApprovals.delete(key);
  return true;
}

export function recordPendingAsk(meta: PendingAskMeta): void {
  pendingAsks.record(meta);
}

export function resolvePendingAsk(sessionId: string, callId: string): void {
  pendingAsks.resolve(sessionId, callId);
}

export function listPendingAsks(sessionId: string): PendingAskMeta[] {
  return pendingAsks.listForSession(sessionId);
}

export function clearApprovalState(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const key of Array.from(cordisPendingApprovals.keys())) {
    if (key.startsWith(prefix)) cordisPendingApprovals.delete(key);
  }
  pendingAsks.clearSession(sessionId);
  clearAskNoncesForSession(sessionId);
}

export function clearAllApprovalState(): void {
  cordisPendingApprovals.clear();
  pendingAsks.clearAll();
  pendingAskNonces.clear();
}
