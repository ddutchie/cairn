const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Allow Metro to resolve modules from the parent repo (for shared types)
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// iOS/Android only — exclude web platform
config.resolver.platforms = ["ios", "android", "native"];

// Stub out react-native-web and any other web-only modules so Metro doesn't
// error when Expo Router's static/SSR files are encountered during graph
// traversal. These modules are never executed on native.
const WEB_ONLY_STUBS = [
  "react-native-web",
  "react-native-web/dist/index",
  "react-dom",
  "react-dom/server",
  "react-dom/server.node",
];

const emptyModulePath = path.resolve(__dirname, "stubs/empty.js");

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (WEB_ONLY_STUBS.some((stub) => moduleName === stub || moduleName.startsWith(stub + "/"))) {
    return { type: "sourceFile", filePath: emptyModulePath };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: "./global.css" });
