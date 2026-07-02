// Metro config for the Cairn mobile app.
//
// The shared "one brain" sync engine lives at <repo>/shared, a sibling of this
// mobile/ folder and OUTSIDE the Expo project root. Metro/`expo export` only
// serve files under the project root, so we consume shared as a normal package:
// scripts/link-shared.js symlinks <repo>/shared into node_modules/@cairn/shared
// (via the postinstall hook). Metro follows that symlink with the settings below.

const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

// Watch the repo root so edits to ../shared hot-reload the app.
config.watchFolders = [repoRoot];

// Resolve node_modules from the mobile project first, then the repo root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(repoRoot, "node_modules"),
];

// Follow the node_modules/@cairn/shared symlink to the real source outside root.
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
