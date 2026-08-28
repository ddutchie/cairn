/**
 * Unit tests for the plugin installer (C2, §20): spec parsing, the built-in tar
 * extractor (round-trip a gzipped ustar archive), the dsh package.json → Cairn
 * plugins.yml mapping, and uninstall. No network — fetch is mocked to return a
 * tarball we build in-memory; no Cordis context.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import * as yaml from "js-yaml";
import { parseSpec, installPlugin, uninstallPlugin } from "./plugin-installer";
import { setPluginsRoot, getPluginsRoot } from "./plugin-loader";

// ── minimal ustar tar writer (mirrors the reader in plugin-installer) ────────
function tarHeader(name: string, size: number, type: "0" | "5"): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000644", 100, 8); // mode
  h.write("0000000", 108, 8); // uid
  h.write("0000000", 116, 8); // gid
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  h.write("00000000000", 136, 12); // mtime
  h.write(type, 156, 1);
  h.write("ustar\0", 257, 6);
  h.write("00", 263, 2);
  // checksum: spaces during compute, then written back
  h.write("        ", 148, 8);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

function buildTarGz(files: Record<string, string>, topDir = "repo-main"): Buffer {
  const chunks: Buffer[] = [];
  const pushFile = (name: string, content: string) => {
    const body = Buffer.from(content, "utf8");
    chunks.push(tarHeader(name, body.length, "0"));
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    body.copy(padded);
    chunks.push(padded);
  };
  chunks.push(tarHeader(`${topDir}/`, 0, "5"));
  for (const [rel, content] of Object.entries(files)) pushFile(`${topDir}/${rel}`, content);
  chunks.push(Buffer.alloc(1024)); // two zero blocks = EOF
  return zlib.gzipSync(Buffer.concat(chunks));
}

const DSH_PKG = JSON.stringify({
  name: "@dsh-external/dsh-visualize",
  main: "lib/index.js",
  exports: { ".": "./lib/index.js", "./client": "./lib/client.js" },
  dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } },
});

function mockFetch(gz: Buffer) {
  return vi.fn(async () => ({
    ok: true,
    headers: { get: () => null } as unknown as Headers,
    arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
  })) as unknown as typeof fetch;
}

let tmp: string;
beforeEach(() => {
  vi.stubEnv("CAIRN_PLUGINS_DEV", "1");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-plugins-"));
  setPluginsRoot(tmp);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
  setPluginsRoot("");
});

describe("parseSpec", () => {
  it("parses github:owner/repo", () => {
    expect(parseSpec("github:Nagi-ovo/dsh-visualize")).toMatchObject({ kind: "github", owner: "Nagi-ovo", repo: "dsh-visualize" });
  });
  it("parses a bare owner/repo and a #ref", () => {
    expect(parseSpec("owner/repo#dev")).toMatchObject({ kind: "github", owner: "owner", repo: "repo", ref: "dev" });
  });
  it("parses a github.com URL and strips .git", () => {
    expect(parseSpec("https://github.com/o/r.git")).toMatchObject({ kind: "github", owner: "o", repo: "r" });
  });
  it("parses an absolute local path", () => {
    expect(parseSpec("/tmp/my-plugin")).toMatchObject({ kind: "local", localPath: "/tmp/my-plugin" });
  });
  it("rejects garbage", () => {
    expect(() => parseSpec("not a spec!!")).toThrow();
  });
});

describe("installPlugin (github, mocked fetch)", () => {
  it("fetches, extracts, and writes a plugins.yml row mapping main + client", async () => {
    const gz = buildTarGz({
      "package.json": DSH_PKG,
      "lib/index.js": "module.exports={};",
      "lib/client.js": "export function apply(ctx){}",
      "cordis.patch.yml": "plugins: {}",
    });
    vi.stubGlobal("fetch", mockFetch(gz));

    const res = await installPlugin("github:Nagi-ovo/dsh-visualize");
    expect(res).toMatchObject({
      id: "dsh-visualize",
      name: "./installed/dsh-visualize/lib/index.js",
      ui: "./installed/dsh-visualize/lib/client.js",
      kind: "both",
    });
    // Files extracted (top dir stripped).
    expect(fs.existsSync(path.join(getPluginsRoot(), "installed/dsh-visualize/lib/index.js"))).toBe(true);
    expect(fs.existsSync(path.join(getPluginsRoot(), "installed/dsh-visualize/package.json"))).toBe(true);
    // Manifest row written.
    const rows = yaml.load(fs.readFileSync(path.join(getPluginsRoot(), "plugins.yml"), "utf8")) as Array<Record<string, unknown>>;
    expect(rows).toContainEqual({ id: "dsh-visualize", name: res.name, ui: res.ui, source: "github:Nagi-ovo/dsh-visualize" });
  });

  it("rejects a package with no dsh section", async () => {
    const gz = buildTarGz({ "package.json": JSON.stringify({ name: "x", main: "index.js" }), "index.js": "" });
    vi.stubGlobal("fetch", mockFetch(gz));
    await expect(installPlugin("github:o/x")).rejects.toThrow(/not a dsh plugin/);
  });

  it("upserts (re-install replaces the same id's row, not duplicates)", async () => {
    const gz = buildTarGz({ "package.json": DSH_PKG, "lib/index.js": "", "lib/client.js": "" });
    vi.stubGlobal("fetch", mockFetch(gz));
    await installPlugin("github:Nagi-ovo/dsh-visualize");
    await installPlugin("github:Nagi-ovo/dsh-visualize");
    const rows = yaml.load(fs.readFileSync(path.join(getPluginsRoot(), "plugins.yml"), "utf8")) as Array<Record<string, unknown>>;
    expect(rows.filter((r) => r.id === "dsh-visualize")).toHaveLength(1);
  });

  it("installs local dsh-context-ring package from disk", async () => {
    const pkgPath = "/Users/gerard/Documents/GitHub/dsh-context-ring";
    if (!fs.existsSync(pkgPath)) return;
    const res = await installPlugin(pkgPath);
    expect(res.id).toBe("dsh-context-ring");
    expect(res.name).toBe("./installed/dsh-context-ring/lib/index.js");
    expect(res.ui).toBe("./installed/dsh-context-ring/lib/client.js");
    expect(fs.existsSync(path.join(getPluginsRoot(), "installed/dsh-context-ring/lib/index.js"))).toBe(true);
    expect(fs.existsSync(path.join(getPluginsRoot(), "installed/dsh-context-ring/lib/client.js"))).toBe(true);
  });
});


describe("uninstallPlugin", () => {
  it("removes the manifest row and the installed files", async () => {
    const gz = buildTarGz({ "package.json": DSH_PKG, "lib/index.js": "", "lib/client.js": "" });
    vi.stubGlobal("fetch", mockFetch(gz));
    await installPlugin("github:Nagi-ovo/dsh-visualize");
    uninstallPlugin("dsh-visualize");
    const rows = yaml.load(fs.readFileSync(path.join(getPluginsRoot(), "plugins.yml"), "utf8")) as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.id === "dsh-visualize")).toBeUndefined();
    expect(fs.existsSync(path.join(getPluginsRoot(), "installed/dsh-visualize"))).toBe(false);
  });
});
