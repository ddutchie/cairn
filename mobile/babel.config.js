module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      // Resolve the @ alias at build time so imports match the tsconfig paths.
      // NOTE: @shared is intentionally NOT aliased here — it lives outside the
      // project root, so Metro resolves it via extraNodeModules in
      // metro.config.js. Aliasing it in babel too produces a wrong relative
      // path (../../../shared) and breaks bundling.
      [
        "module-resolver",
        {
          alias: {
            "@": "./src",
            "@modules": "./modules",
          },
        },
      ],
      // react-native-streamdown runs remend on a worklet thread via Bundle Mode, which needs the
      // worklets plugin configured explicitly (babel-preset-expo only adds it with defaults,
      // and declaring it here makes the preset skip its own copy).
      [
        "react-native-worklets/plugin",
        {
          bundleMode: true,
          importForwarding: { moduleNames: ["remend"] },
        },
      ],
    ],
  };
};
