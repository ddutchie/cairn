import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { resolveCreditSpec, probeCredits } from "./provider-credits";

// Integration check: the app's OWN resolver + parser + probe against the real
// cairn-community providers.json + real keys (from the sibling repo's .env.test).
// Self-skips when the sibling repo / manifest is absent (CI, fresh clones), and
// per-provider when no key is set. Run with keys to prove credits will render.

const COMMUNITY = path.resolve(__dirname, "../../../cairn-community");

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = path.join(COMMUNITY, ".env.test");
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const manifestPath = path.join(COMMUNITY, "providers.json");
// Path checks + env parsing are safe at collection time (existsSync-guarded);
// the manifest read itself is deferred into the test body so an absent sibling
// repo (CI, fresh clones) skips cleanly instead of crashing the suite.
const hasManifest = fs.existsSync(manifestPath);
const hasAnyKey = Object.keys(loadEnv()).some((k) => k.endsWith("_API_KEY"));

describe("app-side credit display against the real community manifest", () => {
  it.skipIf(!hasManifest || !hasAnyKey)(
    "resolves a spec for every descriptor provider and parses live",
    async () => {
      const env = loadEnv();
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const results: string[] = [];
      for (const p of manifest.providers) {
        const spec = p.definition?.credits;
        if (!spec) continue;
        const resolved = resolveCreditSpec(p.definition.baseUrl, manifest.providers);
        if (!resolved) {
          results.push(`✗ ${p.id}: resolveCreditSpec returned null for its OWN baseUrl`);
          continue;
        }
        const envKey = `${p.id.toUpperCase()}_API_KEY`;
        const key = env[envKey] || env[`PROVIDER_${envKey}`];
        if (!key) {
          results.push(`· ${p.id}: no key (set ${envKey}), skipped`);
          continue;
        }
        // Same 12s hang guard the ai:fetchKeyInfo handler applies — a hanging
        // provider fails through the probe's diagnostic path instead of blocking
        // the whole test run.
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 12_000);
        try {
          const probe = await probeCredits(resolved.url, key, resolved.shape, ac.signal);
          results.push(
            probe.info
              ? `✓ ${p.id}: HTTP ${probe.status} → ${JSON.stringify({ remaining: probe.info.remaining, usage: probe.info.usage, limit: probe.info.limit, currency: probe.info.currency })}`
              : `✗ ${p.id}: HTTP ${probe.status}${probe.error ? ` (${probe.error})` : ""}`,
          );
        } finally {
          clearTimeout(timer);
        }
      }
      for (const r of results) console.log(r);
      expect(results.some((r) => r.startsWith("✗"))).toBe(false);
    },
  );
});
