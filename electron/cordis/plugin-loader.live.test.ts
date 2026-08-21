import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getContext } from "./run-cordis-loop";
import { setPluginsRoot, stopWatchingUserPlugins, getPluginsRoot } from "./plugin-loader";

/**
 * §10 Tier 2/3 — the "author a YAML while the app runs, it loads live" proof.
 *
 * We point the plugins root at a temp dir BEFORE the first getContext(), enable
 * the dev flag, boot the shared context, then (simulating you editing files
 * while the app is up) write plugins.yml + plugin files and assert the watcher
 * reconciles them onto the LIVE context — create, update, remove.
 *
 * getContext() memoises one shared context per process, so these steps run as a
 * single sequential test against one plugins root (matching how the real app
 * has exactly one live context + one watcher).
 *
 * Gated on CAIRN_PLUGINS_DEV=1 (builds the full shared tree; kept out of the
 * default run).
 */

const RUN = process.env.CAIRN_PLUGINS_DEV === "1";

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await wait(80);
  }
  return pred();
}

describe("runtime plugin loading (gated on CAIRN_PLUGINS_DEV=1)", () => {
  afterEach(() => stopWatchingUserPlugins());

  it("loads/updates/removes plugins authored live, incl. the shipped hello-tool example", async () => {
    if (!RUN) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-plugins-"));
    setPluginsRoot(root);
    expect(getPluginsRoot()).toBe(root);

    // Boot the shared context (mounts static tree + loadUserPlugins + watch).
    const ctx = await getContext();
    expect(ctx).toBeTruthy();
    const loader = (ctx as unknown as { loader: { resolve: (id: string) => unknown } }).loader;
    const toolNames = (): string[] => {
      const t = (ctx as unknown as { tools: { schemas?: () => Array<{ function?: { name: string }; name?: string }>; list?: () => Array<{ name: string }> } }).tools;
      const raw = t?.schemas?.() ?? t?.list?.() ?? [];
      return (raw as Array<{ function?: { name: string }; name?: string }>).map((s) => s.function?.name ?? s.name ?? "");
    };

    // ── 1. A bespoke probe plugin authored WHILE the app runs ──
    const marker = "__cairnPluginProbe";
    (globalThis as Record<string, unknown>)[marker] = { loaded: false, config: null };
    fs.writeFileSync(
      path.join(root, "probe.mjs"),
      `export const name='cairn-probe';\nexport function apply(ctx, config){ const g=globalThis['${marker}']; g.loaded=true; g.config=config; }\n`,
    );
    const probe = () => (globalThis as Record<string, { loaded: boolean; config: unknown }>)[marker];
    expect(probe().loaded).toBe(false);

    fs.writeFileSync(path.join(root, "plugins.yml"), `- id: probe\n  name: ./probe.mjs\n  config:\n    greeting: LIVE-YAML\n`);
    expect(await waitFor(() => probe().loaded === true)).toBe(true);
    expect((probe().config as { greeting?: string })?.greeting).toBe("LIVE-YAML");

    // ── 2. The SHIPPED example (registers a real agent-visible `hello` tool) ──
    fs.copyFileSync(path.join(__dirname, "plugins-template", "hello-tool.mjs"), path.join(root, "hello-tool.mjs"));
    expect(toolNames()).not.toContain("hello");
    fs.writeFileSync(
      path.join(root, "plugins.yml"),
      `- id: probe\n  name: ./probe.mjs\n  config: { greeting: LIVE-YAML }\n- id: hello-tool\n  name: ./hello-tool.mjs\n  config: { excitement: 2 }\n`,
    );
    expect(await waitFor(() => toolNames().includes("hello"))).toBe(true);

    // ── 3. Remove everything → live entries torn down, tool unregistered ──
    fs.writeFileSync(path.join(root, "plugins.yml"), `[]\n`);
    expect(await waitFor(() => { try { loader.resolve("probe"); return false; } catch { return true; } })).toBe(true);
    expect(await waitFor(() => !toolNames().includes("hello"))).toBe(true);

    stopWatchingUserPlugins();
    fs.rmSync(root, { recursive: true, force: true });
  }, 30000);
});
