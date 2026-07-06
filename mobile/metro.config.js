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

// Ensure the @cairn/shared symlink exists before every bundle. `npm install`
// self-heals it via the postinstall hook, but `npx expo install <pkg>` (and
// other install paths) can prune it WITHOUT running postinstall, leaving a
// broken build ("Unable to resolve module @cairn/shared/..."). Metro config is
// evaluated on every start/bundle regardless of how the build was launched, so
// linking here guarantees it's present.
require("./scripts/link-shared");

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
