#!/usr/bin/env node
// Arcade frame benchmark (docs/arcade-play.md): bundles bench.ts and runs it
// under `node --jitless`, an interpreter like Hermes on the phone.
//   npm run arcade:bench -- wayfinder 233 339
//   npm run arcade:bench -- tideglass 233 339 --jit   (with the JIT, like Chrome)
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);
const jit = args.includes("--jit");
const rest = args.filter((a) => a !== "--jit");

const dir = mkdtempSync(join(tmpdir(), "arcade-bench-"));
const out = join(dir, "bench.mjs");
try {
  await esbuild.build({
    entryPoints: [join(here, "bench.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    alias: { "@cairn/shared": join(root, "shared") },
    logLevel: "warning",
  });
  const games = rest.length && !/^\d/.test(rest[0]) ? [rest[0]] : ["tideglass", "powder-run", "basecamp", "wayfinder"];
  const size = rest.length && !/^\d/.test(rest[0]) ? rest.slice(1) : rest;
  for (const g of games) {
    const r = spawnSync(process.execPath, [...(jit ? [] : ["--jitless"]), out, g, ...size], { stdio: "inherit" });
    if (r.status) process.exitCode = r.status;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
