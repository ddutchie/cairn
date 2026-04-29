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
