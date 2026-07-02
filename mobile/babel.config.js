module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      // Resolve the @shared and @ aliases at build time so imports match the
      // tsconfig paths above.
      [
        "module-resolver",
        {
          alias: {
            "@": "./src",
            "@shared": "../shared",
          },
        },
      ],
    ],
  };
};
