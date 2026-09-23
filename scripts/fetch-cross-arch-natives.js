#!/usr/bin/env node
/**
 * Fetch the per-platform packages that bundled code resolves at runtime, for
 * EVERY arch electron-builder will package (not just the build machine's).
 *
 * npm installs optional platform packages only for the host CPU, but mac and
 * win are packaged for both arm64 and x64 from one machine. Without this, the
 * non-host installer ships without ripgrep (glob/grep) and without the dsh
 * native addon (macOS/Linux session lock, Linux Landlock launcher).
 * scripts/after-pack.js strips the other arch from each app afterwards.
 *
 * Uses `npm pack` + in-process extraction rather than `npm install --no-save`, which
 * can prune or rewrite the installed tree. Versions come from the parent
 * package's optionalDependencies, so they always match what's installed.
 *
 * Usage: node scripts/fetch-cross-arch-natives.js [--mac] [--win] [--linux]
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");
const nodeModules = path.join(root, "node_modules");

/** Parent packages whose `<parent>-<platform>-<arch>` optional deps are resolved at runtime. */
const PARENTS = ["@vscode/ripgrep", "@deepseek-ai/node-addon-system"];

/** Matches the `arch:` lists in electron-builder.yml. */
const TARGETS = {
  mac: { platform: "darwin", arches: ["arm64", "x64"] },
  win: { platform: "win32", arches: ["x64", "arm64"] },
  linux: { platform: "linux", arches: ["x64", "arm64"] },
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function installedVersion(name) {
  const manifest = path.join(nodeModules, name, "package.json");
  return fs.existsSync(manifest) ? readJson(manifest).version : undefined;
}

/**
 * Extract an npm tarball's `package/` tree into `dest`, keeping file modes
 * (rg / landlock-run must stay executable). In-process rather than shelling
 * out to tar: GNU tar under Git Bash mangles Windows drive paths.
 */
function extractPackage(tarball, dest) {
  const data = zlib.gunzipSync(fs.readFileSync(tarball));
  const field = (block, start, len) => block.toString("utf8", start, start + len).replace(/\0.*$/s, "");
  let paxPath;
  for (let offset = 0; offset + 512 <= data.length; ) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = field(header, 156, 1) || "0";
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // pax extended header: node-tar uses it for long paths.
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
      continue;
    }
    if (type === "g") continue;
    const prefix = field(header, 345, 155);
    const entry = paxPath ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    paxPath = undefined;
    const rel = entry.replace(/^package\//, "");
    const target = path.join(dest, rel);
    if (!target.startsWith(dest + path.sep)) throw new Error(`unsafe path in ${tarball}: ${entry}`);
    if (type === "5") {
      fs.mkdirSync(target, { recursive: true });
    } else if (type === "0") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      const mode = parseInt(field(header, 100, 8).trim() || "644", 8);
      if (process.platform !== "win32") fs.chmodSync(target, mode & 0o777);
    }
  }
}

function fetchPackage(name, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-native-"));
  try {
    // npm on Windows is a .cmd shim, which execFile can only run via a shell.
    const out = execFileSync("npm", ["pack", `${name}@${version}`, "--silent", "--pack-destination", tmp], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    const tarball = path.join(tmp, out.trim().split(/\r?\n/).pop());
    const dest = path.join(nodeModules, name);
    fs.rmSync(dest, { recursive: true, force: true });
    extractPackage(tarball, dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const requested = Object.keys(TARGETS).filter((flag) => process.argv.includes(`--${flag}`));
  if (requested.length === 0) {
    console.error("Usage: node scripts/fetch-cross-arch-natives.js [--mac] [--win] [--linux]");
    process.exit(1);
  }
  for (const parent of PARENTS) {
    const parentManifest = path.join(nodeModules, parent, "package.json");
    if (!fs.existsSync(parentManifest)) throw new Error(`${parent} is not installed — run npm install first`);
    const optional = readJson(parentManifest).optionalDependencies ?? {};
    for (const flag of requested) {
      const { platform, arches } = TARGETS[flag];
      for (const arch of arches) {
        const name = `${parent}-${platform}-${arch}`;
        const version = optional[name];
        if (version === undefined) continue; // parent has no build for this target
        if (installedVersion(name) === version) continue;
        console.log(`[fetch-cross-arch-natives] ${name}@${version}`);
        fetchPackage(name, version);
      }
    }
  }
}

main();
