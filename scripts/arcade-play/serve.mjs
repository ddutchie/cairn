#!/usr/bin/env node
// Serves the arcade play harness (docs/arcade-play.md). esbuild rebuilds
// play.ts on every page load, so a browser refresh picks up source edits.
import * as esbuild from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const port = Number(process.env.PORT ?? process.argv[2] ?? 4179);

const ctx = await esbuild.context({
  entryPoints: [join(here, "play.ts")],
  bundle: true,
  format: "iife",
  outdir: here,
  write: false,
  sourcemap: "inline",
  alias: { "@cairn/shared": join(root, "shared"), "@app": join(root, "src") },
  logLevel: "warning",
});
const { port: bound } = await ctx.serve({ servedir: here, host: "127.0.0.1", port });
console.log(`arcade play: http://localhost:${bound}/?g=wayfinder&w=320&h=320&k=2`);
