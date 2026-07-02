// Metro config for the Cairn mobile app.
//
// The shared sync engine lives in ../shared (a sibling of this mobile/ folder,
// outside the Expo project root). Metro only watches the project root by
// default, so we add the repo root as an extra watch folder and alias
// "@shared" to it. This lets the mobile app import the *identical* sync engine
// the desktop uses (see plan §3 / docs/plans/mobile-app-viability.md).

const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

// Watch the repo root so ../shared changes trigger reloads.
config.watchFolders = [repoRoot];

// Resolve node_modules from the mobile project first, then the repo root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(repoRoot, "node_modules"),
];

// Alias @shared -> ../shared so `@shared/sync` resolves.
config.resolver.extraNodeModules = {
  "@shared": path.resolve(repoRoot, "shared"),
};

module.exports = config;
