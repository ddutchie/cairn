/**
 * Shared navigation guard for Electron windows (main window + chat popout).
 *
 * Deny any in-page navigation to external origins. Only the bundled schemes
 * and loopback dev servers are allowed. Loopback membership comes from the
 * shared classifier (`isLoopbackHost` — key-exempt set, never leaves the
 * host); remote or invalid hosts are denied.
 */

import { isLoopbackHost } from "../../shared/net/address";

/** True when an in-page navigation to `url` may proceed. */
export function isAllowedNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "app:" || parsed.protocol === "asset:") return true;
    if (parsed.protocol === "http:" || parsed.protocol === "ws:" || parsed.protocol === "https:") {
      return isLoopbackHost(parsed.hostname);
    }
    return false;
  } catch {
    // Malformed URL — deny.
    return false;
  }
}
