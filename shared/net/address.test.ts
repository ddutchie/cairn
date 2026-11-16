/**
 * Tests for the shared local/private address classifier (Phase B1, F7).
 *
 * Section 1 pins the `web_fetch` refusal set byte-for-byte: these cases are
 * copied from `electron/agent/tools/tools.test.ts` ("flags private and
 * loopback addresses") and the shared predicate must give identical answers.
 *
 * Section 2 records each current caller's answer TODAY (verified against the
 * implementations on `main`) alongside the unified answer. Deltas are
 * intentional and reviewed:
 * - `url-metadata` becomes stricter (IPv6 ULA/private, CGNAT, multicast,
 *   `0.0.0.0`, bracketed IPv6) — the point of the extraction.
 * - usage "Local" labelling gains link-local (and other newly-covered
 *   non-public ranges); localhost/127.x/LAN answers are unchanged.
 * - key-exemption (`isLocalEndpoint` / renderer) broadens only within
 *   loopback spellings (`127.0.0.2`, `*.localhost`, `::`); LAN hosts still
 *   need a key (Q3: no conflation with fetch refusal).
 * - the window nav guard allows the same loopback set as the key exemption.
 */

import { describe, expect, it } from "vitest";
import { classifyHost, isLocalBaseUrl, isLoopbackHost, isPrivateAddress } from "./address";

describe("isPrivateAddress — web_fetch refusal set (must not change)", () => {
  it("refuses the exact inputs web_fetch refuses today", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.5",
      "172.20.0.1",
      "169.254.169.254",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
      "::ffff:c0a8:1",
      "64:ff9b::7f00:1",
      "224.0.0.1",
      "198.18.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("still refuses every other non-public input web_fetch refuses", () => {
    for (const ip of [
      "0.0.0.0",
      "0.1.2.3",
      "100.64.0.1",
      "100.127.255.255",
      "192.0.0.1",
      "198.19.2.3",
      "240.0.0.1",
      "255.255.255.255",
      "localhost",
      "foo.localhost",
      "[::1]",
      "[::]",
      "fe80::1%eth0",
      "fc00::1",
      "ff02::1",
      "::ffff:0.0.0.0",
      "64:ff9b::c0a8:101",
      "not-an-ip:::",
      "999.1.1.1",
      "",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("still allows documentation and public ranges web_fetch allows", () => {
    for (const ip of ["192.0.2.1", "198.51.100.7", "203.0.113.9", "8.8.4.4", "2001:4860:4860::8888"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("classifyHost", () => {
  it.each([
    ["localhost", "loopback"],
    ["LOCALHOST", "loopback"],
    ["foo.localhost", "loopback"],
    ["127.0.0.1", "loopback"],
    ["127.0.0.2", "loopback"],
    ["0.0.0.0", "loopback"],
    ["::1", "loopback"],
    ["::", "loopback"],
    ["[::1]", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["192.0.0.1", "private"],
    ["198.18.0.1", "private"],
    ["224.0.0.1", "private"],
    ["fc00::1", "private"],
    ["ff02::1", "private"],
    ["::ffff:10.0.0.1", "private"],
    ["169.254.10.20", "link-local"],
    ["fe80::1", "link-local"],
    ["8.8.8.8", "public"],
    ["api.openai.com", "public"],
    ["localhost.evil.com", "public"],
    ["oak-ridge.ai", "public"],
    ["999.1.1.1", "invalid"],
    ["", "invalid"],
  ] as Array<[string, string]>)("classifyHost(%j) === %j", (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });
});

describe("per-caller behaviour — today vs unified", () => {
  it("llm isLocalEndpoint: loopback spellings need no key (LAN still needs one)", () => {
    // Today: localhost, 127.0.0.1, 0.0.0.0, [::1]/::1 → true; everything else false.
    // Unified: same, plus the remaining loopback spellings (still this-machine).
    const local = ["http://localhost:11434", "http://127.0.0.1:11434", "http://0.0.0.0:8080", "http://[::1]:11434"];
    for (const baseUrl of local) expect(isLocalBaseUrl(baseUrl), `${baseUrl} (was local)`).toBe(true);
    const stillNeedsKey = ["http://192.168.1.50:11434", "https://api.openai.com", "http://10.0.0.5:8080", "http://169.254.10.20:8080"];
    for (const baseUrl of stillNeedsKey) expect(isLocalBaseUrl(baseUrl), `${baseUrl} (still keyed)`).toBe(false);
    // Deliberate loopback-only broadening (was: key required; now: key-exempt, safe — never leaves the host).
    for (const baseUrl of ["http://127.0.0.2:11434", "http://foo.localhost:11434", "http://[::]:11434"]) {
      expect(isLocalBaseUrl(baseUrl), `${baseUrl} (loopback broadening)`).toBe(true);
    }
    expect(isLocalBaseUrl("not a url [[[")).toBe(false);
  });

  it("usage labelling: localhost / 127.x / LAN stay Local; link-local joins them", () => {
    // usage-recorder treats loopback|private|link-local as "Local" (invalid falls through as before).
    const local = (host: string) => {
      const c = classifyHost(host);
      return c === "loopback" || c === "private" || c === "link-local";
    };
    // Unchanged from today.
    for (const host of ["localhost", "127.0.0.1", "192.168.1.50", "10.0.0.5", "172.20.0.1", "::1"]) {
      expect(local(host), `${host} (was Local)`).toBe(true);
    }
    for (const host of ["api.openai.com", "api-gateway.merge.dev", "8.8.8.8"]) {
      expect(local(host), `${host} (was not Local)`).toBe(false);
    }
    // Deliberate: link-local (and other newly-covered non-public ranges) now label Local.
    for (const host of ["169.254.169.254", "fe80::1", "100.64.0.1", "fc00::1"]) {
      expect(local(host), `${host} (newly Local)`).toBe(true);
    }
  });

  it("url-metadata: refuses everything it refused plus the IPv6/CGNAT gaps (message unchanged)", () => {
    const assertPublicHost = (hostname: string) => {
      if (classifyHost(hostname) !== "public") throw new Error("Non-public host");
    };
    // Refused today and still refused.
    for (const host of ["localhost", "::1", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.5", "169.254.169.254", "fe80::1"]) {
      expect(() => assertPublicHost(host), host).toThrow("Non-public host");
    }
    // Allowed today, refused now — the stated strictness win.
    for (const host of ["0.0.0.0", "::", "100.64.0.1", "192.0.0.1", "198.18.0.1", "fc00::1", "ff02::1", "224.0.0.1", "foo.localhost", "[fe80::1]"]) {
      expect(() => assertPublicHost(host), host).toThrow("Non-public host");
    }
    // Still fetchable.
    for (const host of ["example.com", "8.8.8.8", "2606:4700:4700::1111"]) {
      expect(() => assertPublicHost(host), host).not.toThrow();
    }
  });

  it("window nav guard: bundled schemes plus loopback dev servers", () => {
    const allowed = (url: string) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "app:" || parsed.protocol === "asset:") return true;
        if (parsed.protocol === "http:" || parsed.protocol === "ws:" || parsed.protocol === "https:") {
          return isLoopbackHost(parsed.hostname);
        }
        return false;
      } catch {
        return false;
      }
    };
    // Allowed today and still allowed.
    for (const url of ["app://./index.html", "asset://icon.png", "http://localhost:3000", "http://127.0.0.1:3000", "ws://localhost:3000", "https://localhost:3000"]) {
      expect(allowed(url), url).toBe(true);
    }
    // Denied today and still denied.
    for (const url of ["https://example.com", "http://192.168.1.50:3000", "http://10.0.0.5:3000", "file:///etc/passwd", "not a url"]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it("isLoopbackHost stays distinct from isPrivateAddress (Q3)", () => {
    // LAN needs a key (not loopback) but must not be fetched (private).
    expect(isLoopbackHost("192.168.1.50")).toBe(false);
    expect(isPrivateAddress("192.168.1.50")).toBe(true);
    // Link-local is neither loopback nor public.
    expect(isLoopbackHost("169.254.169.254")).toBe(false);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    // Loopback refuses fetch too.
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
  });
});
