/**
 * Lazy, per-language lowlight registry.
 *
 * Previously `createLowlight(common)` ran at module import, pulling all ~37
 * highlight.js grammars into the main bundle and evaluating them at startup —
 * a fixed cost paid whenever the code-fence renderer was imported (i.e. on
 * every note preview mount), even for notes with no code.
 *
 * This module instead starts with an EMPTY lowlight instance and dynamically
 * imports each grammar the first time a code block of that language is rendered.
 * The bundler code-splits each grammar into its own chunk, so startup only loads
 * what's actually used. Rendering stays synchronous: a not-yet-loaded language
 * highlights as plain text on the first pass and re-highlights once its grammar
 * chunk resolves (callers subscribe via `onLanguageReady`).
 */

import { createLowlight } from "lowlight";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Grammar = any;

const lowlight = createLowlight();

// ── Loader table ──────────────────────────────────────────────────────────────
// Maps a canonical language name to a dynamic import of its highlight.js grammar.
// Only the "common" set is wired here (the languages the app previously bundled);
// unknown languages simply fall back to plain text, exactly as before. Aliases
// (e.g. "js" → javascript) are resolved by highlight.js once the canonical
// grammar is registered, so we only map canonical names + a few common aliases.
const LOADERS: Record<string, () => Promise<{ default: Grammar }>> = {
  arduino:    () => import("highlight.js/lib/languages/arduino"),
  bash:       () => import("highlight.js/lib/languages/bash"),
  c:          () => import("highlight.js/lib/languages/c"),
  cpp:        () => import("highlight.js/lib/languages/cpp"),
  csharp:     () => import("highlight.js/lib/languages/csharp"),
  css:        () => import("highlight.js/lib/languages/css"),
  diff:       () => import("highlight.js/lib/languages/diff"),
  go:         () => import("highlight.js/lib/languages/go"),
  graphql:    () => import("highlight.js/lib/languages/graphql"),
  ini:        () => import("highlight.js/lib/languages/ini"),
  java:       () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json:       () => import("highlight.js/lib/languages/json"),
  kotlin:     () => import("highlight.js/lib/languages/kotlin"),
  less:       () => import("highlight.js/lib/languages/less"),
  lua:        () => import("highlight.js/lib/languages/lua"),
  makefile:   () => import("highlight.js/lib/languages/makefile"),
  markdown:   () => import("highlight.js/lib/languages/markdown"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  perl:       () => import("highlight.js/lib/languages/perl"),
  php:        () => import("highlight.js/lib/languages/php"),
  "php-template": () => import("highlight.js/lib/languages/php-template"),
  plaintext:  () => import("highlight.js/lib/languages/plaintext"),
  python:     () => import("highlight.js/lib/languages/python"),
  "python-repl": () => import("highlight.js/lib/languages/python-repl"),
  r:          () => import("highlight.js/lib/languages/r"),
  ruby:       () => import("highlight.js/lib/languages/ruby"),
  rust:       () => import("highlight.js/lib/languages/rust"),
  scss:       () => import("highlight.js/lib/languages/scss"),
  shell:      () => import("highlight.js/lib/languages/shell"),
  sql:        () => import("highlight.js/lib/languages/sql"),
  swift:      () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  vbnet:      () => import("highlight.js/lib/languages/vbnet"),
  wasm:       () => import("highlight.js/lib/languages/wasm"),
  xml:        () => import("highlight.js/lib/languages/xml"),
  yaml:       () => import("highlight.js/lib/languages/yaml"),
};

// Common fence aliases → canonical loader key. highlight.js resolves its own
// aliases post-registration, but the fence language may use an alias whose
// canonical grammar we haven't loaded yet — so map the alias to the loader.
const ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python",
  rb: "ruby",
  sh: "bash", zsh: "bash", console: "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp", cc: "cpp", h: "cpp", hpp: "cpp",
  "c#": "csharp", cs: "csharp",
  html: "xml", svg: "xml", xhtml: "xml", htm: "xml",
  golang: "go",
  rs: "rust",
  kt: "kotlin",
  objc: "objectivec",
  text: "plaintext", txt: "plaintext",
};

const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/** Resolve a fence language token to a canonical loader key, or null if unknown. */
function resolveKey(language: string): string | null {
  const lang = language.toLowerCase().trim();
  if (LOADERS[lang]) return lang;
  const alias = ALIASES[lang];
  if (alias && LOADERS[alias]) return alias;
  return null;
}

/**
 * Kick off loading a grammar if it's a known-but-unregistered language. Returns
 * true if the grammar is registered and ready to highlight synchronously NOW.
 */
export function ensureLanguage(language: string | undefined): boolean {
  if (!language) return false;
  const key = resolveKey(language);
  if (!key) return false; // unknown → caller falls back to plain text
  if (lowlight.registered(key)) return true;
  if (!loading.has(key)) {
    const p = LOADERS[key]()
      .then((mod) => {
        const grammar = (mod as { default: Grammar }).default ?? mod;
        if (!lowlight.registered(key)) lowlight.register(key, grammar);
      })
      .catch(() => {
        // Leave unregistered — highlight() will fall back to plain text.
      })
      .finally(() => {
        loading.delete(key);
        // Notify subscribers so mounted code blocks re-render + re-highlight.
        for (const l of listeners) l();
      });
    loading.set(key, p);
  }
  return false;
}

/** True if the language's grammar is registered and can be highlighted now. */
export function isLanguageReady(language: string | undefined): boolean {
  if (!language) return false;
  const key = resolveKey(language);
  return key ? lowlight.registered(key) : false;
}

/** Highlight code for an already-registered language. Caller must have checked
 *  isLanguageReady/ensureLanguage first; returns null if not registered. */
export function highlightCode(language: string, code: string) {
  const key = resolveKey(language);
  if (!key || !lowlight.registered(key)) return null;
  try {
    return lowlight.highlight(key, code).children;
  } catch {
    return null;
  }
}

/** Subscribe to grammar-load completions. Returns an unsubscribe fn. */
export function onLanguageReady(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
