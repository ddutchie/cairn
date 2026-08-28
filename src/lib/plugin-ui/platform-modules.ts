/**
 * Platform module table — the set of module specifiers a plugin bundle may
 * `require()` (or `import`) at runtime, resolved to Cairn's own instances/shims.
 *
 * Why this exists: real dsh community client plugins are built (tsdown) as CJS
 * that bundles their own code inline but keeps a "platform module table"
 * EXTERNAL — react, react/jsx-runtime, react-dom, @deepseek-ai/cordis, and the
 * @deepseek-ai/dsh-client-* packages — expecting the host to provide them via
 * `require`. (See dsh-visualize's tsdown.config.ts PLATFORM_MODULES.) Cairn is
 * that host: we hand plugins ONE React instance (critical — never two) plus
 * thin shims that map dsh's client APIs onto Cairn's plugin-UI registry.
 *
 * A plugin should still prefer Cairn's `ui` API (via activate(ui)); this table
 * is what makes an unmodified dsh-shaped bundle resolvable.
 */
import * as React from "react";
import * as ReactDOM from "react-dom";
// react/jsx-runtime is resolved lazily below (bundlers expose it as a submodule).

/** Build the module table. Kept as a factory so per-plugin shims (which need the
 *  plugin id for scoped registration) can be layered on top by the caller. */
export function createPlatformModules(): Record<string, unknown> {
  // React's jsx-runtime — required by any bundle compiled with the automatic
  // JSX runtime. Import via the static specifier so the bundler includes it.
  let jsxRuntime: unknown;
  let jsxDevRuntime: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jsxRuntime = require("react/jsx-runtime");
  } catch { /* older React / not bundled */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jsxDevRuntime = require("react/jsx-dev-runtime");
  } catch { /* prod build */ }

  const table: Record<string, unknown> = {
    react: React,
    "react-dom": ReactDOM,
  };
  if (jsxRuntime) table["react/jsx-runtime"] = jsxRuntime;
  if (jsxDevRuntime) table["react/jsx-dev-runtime"] = jsxDevRuntime;
  try {
    // react-dom/client (createRoot) — some plugins render their own subtree.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    table["react-dom/client"] = require("react-dom/client");
  } catch { /* optional */ }
  return table;
}

/** Specifiers we recognise but deliberately do NOT provide yet (dsh-client-*
 *  needs the ctx-adapter shim — a later step). Resolving one throws a clear
 *  error naming the gap, instead of a cryptic "require is not allowed". */
export const KNOWN_UNPROVIDED = new Set<string>([
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-runtime/client",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-tool",
  "@deepseek-ai/dsh-client-ui-tool/client",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-schema-form",
]);
