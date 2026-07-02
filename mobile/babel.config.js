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
          },
        },
      ],
    ],
  };
};
