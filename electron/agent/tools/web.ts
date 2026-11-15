/** web_fetch: GET a public http(s) page and return it as text. Refuses private/loopback addresses. */
import dns from "node:dns/promises";
import net from "node:net";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { clampMiddle, fail, ok } from "./schema";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 60_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20_000;

/** The 16-bit groups of an IPv6 address, or undefined when it is not one. */
function v6Groups(ip: string): number[] | undefined {
  if (!net.isIPv6(ip)) return undefined;
  let text = ip.split("%")[0].toLowerCase();
  // A dotted IPv4 tail (`::ffff:127.0.0.1`) is the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = text.includes("::") ? new Array(Math.max(0, 8 - left.length - right.length)).fill("0") : [];
  const groups = [...left, ...fill, ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : undefined;
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const g = v6Groups(ip);
  // Not an address we can read: refuse rather than guess.
  if (!g) return true;
  const embedded = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  // IPv4 carried inside IPv6, in either spelling (`::ffff:127.0.0.1` is `::ffff:7f00:1`): mapped, compatible, NAT64.
  if ((zeros(5) && g[5] === 0xffff) || zeros(6) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))) {
    if (zeros(6) && g[6] === 0 && g[7] <= 1) return true; // `::` and `::1`
    return isPrivateAddress(embedded);
  }
  // Unique local (fc00::/7), link local (fe80::/10), multicast (ff00::/8).
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs can be fetched");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("Refusing to fetch a local address");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new Error("Refusing to fetch a private network address");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  void reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString("utf8");
}

export function webFetchTool(): AgentTool {
  return defineTool({
    name: "web_fetch",
    description: "Fetch a public web page by URL and return its text content. Private and local addresses are refused.",
    parameters: Type.Object({ url: Type.String({ description: "http(s) URL to fetch." }) }),
    risk: (a) => {
      let host: string | undefined;
      try { host = new URL(a.url).hostname; } catch { /* surfaced by execute */ }
      return { class: "EXTERNAL", host };
    },
    preview: (a) => a.url,
    concurrency: "parallel",
    async execute(a, ctx) {
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
      try {
        let url = new URL(a.url);
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          await assertPublic(url);
          const res = await fetch(url, { redirect: "manual", signal, headers: { "user-agent": "Cairn/1 (+web_fetch)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } });
          if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { url = new URL(res.headers.get("location")!, url); continue; }
          if (!res.ok) return fail(`HTTP ${res.status} ${res.statusText} for ${url.href}`);
          const type = res.headers.get("content-type") ?? "";
          if (/^(image|audio|video)\//.test(type) || type.includes("octet-stream") || type.includes("pdf")) return fail(`Unsupported content type: ${type}`);
          const body = await readCapped(res);
          const text = type.includes("html") ? htmlToText(body) : body;
          return ok(clampMiddle(text, MAX_CHARS) || "(empty response)");
        }
        return fail("Too many redirects");
      } catch (err) {
        return fail(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
