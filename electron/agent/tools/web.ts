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

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
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
