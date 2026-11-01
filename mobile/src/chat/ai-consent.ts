/**
 * One-time consent before notes and chat go to a third-party AI provider.
 *
 * With an OpenAI-compatible endpoint, chat messages and the notes and tasks the
 * assistant reads are sent to that service. App Review (Guideline 5.1.2(i))
 * wants the user told who receives personal data and asked first, so the first
 * request to each new host asks once, and the answer is remembered per host in
 * the device-local meta DB. Endpoints on this device or the local network are
 * exempt: nothing leaves the user's own machines. Apple Intelligence never goes
 * through here (on-device, or Apple's Private Cloud Compute).
 */

import { Alert } from "react-native";
import { getMeta, setMeta } from "@/db";

export class AiConsentDeclinedError extends Error {
  constructor(host: string) {
    super(
      `You chose not to send your notes and messages to ${host}. To use it, start a new message and choose Allow, or pick another provider in Settings → AI.`,
    );
    this.name = "AiConsentDeclinedError";
  }
}

/** Lower-cased host of an endpoint URL, or null when it doesn't parse. */
export function endpointHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Loopback, `.local`, single-label and private-range hosts: data stays on the user's network. */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1") return true;
  if (!h.includes(".") && !h.includes(":")) return true; // single-label LAN name
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export interface ConsentDeps {
  get(key: string): string | null;
  set(key: string, value: string): void;
  /** Ask the user; resolves true for Allow. */
  ask(host: string): Promise<boolean>;
}

function askWithAlert(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      `Send your data to ${host}?`,
      `To answer, Cairn sends your messages and the notes and tasks the assistant reads to ${host}, the AI provider you set up. Their privacy policy covers what happens to it there. Cairn doesn't send it anywhere else.`,
      [
        { text: "Don't allow", style: "cancel", onPress: () => resolve(false) },
        { text: "Allow", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

const defaultDeps: ConsentDeps = { get: getMeta, set: setMeta, ask: askWithAlert };

function consentKey(host: string): string {
  return `ai.consent.${host}`;
}

/**
 * Resolve when the user has agreed to send data to `baseUrl`'s host (asking the
 * first time); throws AiConsentDeclinedError when they decline. A decline isn't
 * remembered, so the next attempt asks again rather than failing silently.
 */
export async function ensureAiConsent(baseUrl: string, deps: ConsentDeps = defaultDeps): Promise<void> {
  const host = endpointHost(baseUrl);
  if (!host || isLocalHost(host)) return;
  if (deps.get(consentKey(host)) === "1") return;
  if (await deps.ask(host)) {
    deps.set(consentKey(host), "1");
    return;
  }
  throw new AiConsentDeclinedError(host);
}
