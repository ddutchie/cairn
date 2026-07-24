// ESLint (flat config) for the Cairn mobile app.
//
// The repo-root eslint.config.mjs is a Next.js / web config and flags valid
// React Native patterns (reanimated worklet `sharedValue.value = …`, RN <Image>
// with no `alt`, etc.). Mobile is linted here instead with the RN-aware
// eslint-config-expo. The root config ignores mobile/ (see repo eslint.config.mjs).

const expoConfig = require("eslint-config-expo/flat");
const tsPlugin = require("@typescript-eslint/eslint-plugin");

module.exports = [
  ...expoConfig,
  {
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      // Honour the _name convention for intentionally-unused vars/params.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // react-hooks/immutability flags `sharedValue.value = …` inside
      // Reanimated worklets, but mutating a shared value is exactly how the
      // Reanimated API works (it's not a React prop/hook value). Off for RN.
      "react-hooks/immutability": "off",

      // The MCP SDK ships subpath entry points via package.json "exports" with
      // .js specifiers (e.g. @modelcontextprotocol/sdk/client/streamableHttp.js).
      // Metro (unstable_enablePackageExports) and tsc both resolve these, but
      // eslint-plugin-import's resolver doesn't read the exports map, so it false-
      // positives on no-unresolved. Ignore that one package rather than weaken the
      // rule globally.
      "import/no-unresolved": ["error", { ignore: ["^@modelcontextprotocol/sdk/"] }],

      // Fires on well-established patterns like seeding a controlled input when
      // a modal opens or restoring state on mount. These are correct uses of
      // useEffect — downgrade to warn (matches the repo-root web config).
      "react-hooks/set-state-in-effect": "warn",

      // Reanimated's useAnimatedStyle/useDerivedValue read shared values that
      // the linter can't see as deps; its manual memoization is intentional.
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
  {
    ignores: [
      "dist/**",
      ".expo/**",
      "ios/**",
      "android/**",
      "expo-env.d.ts",
      // Generated, vendored WebView bundles (KaTeX / Mermaid) — not hand-written.
      "src/webview-assets/**",
      // Node CJS helper scripts.
      "scripts/**",
    ],
  },
];
