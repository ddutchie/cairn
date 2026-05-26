#!/usr/bin/env node
/**
 * Cairn — License + stack generator
 *
 * Reads all dependencies from package.json, resolves their installed version
 * and license from node_modules/<pkg>/package.json, maps each to a human-
 * readable role and category, and writes src/generated/licenses.json.
 *
 * Run automatically by build.js before the Next.js build step.
 * Can also be run standalone: node scripts/generate-licenses.js
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

// ── Role map: package name → [label, role, category] ─────────────────────────
// Covers the packages we actually ship in the UI. Anything not listed here
// is treated as infrastructure and still included in the full license list
// but excluded from the "Stack" display grid.
//
// Categories: Platform | Data | AI | UI | Editor | Agent | Visualisation
const ROLE_MAP = {
  // ── Platform ────────────────────────────────────────────────────────────────
  "electron":                      ["Electron",            "Desktop shell",               "Platform"],
  "next":                          ["Next.js",             "UI framework",                "Platform"],
  "react":                         ["React",               "Renderer",                    "Platform"],
  "typescript":                    ["TypeScript",          "Language",                    "Platform"],
  "esbuild":                       ["esbuild",             "Bundler",                     "Platform"],
  "electron-updater":              ["electron-updater",    "Auto-updater",                "Platform"],
  "koffi":                         ["Koffi",               "Fast native FFI bridge",      "Platform"],

  // ── Data ────────────────────────────────────────────────────────────────────
  "better-sqlite3":                ["better-sqlite3",      "Local database",              "Data"],
  "zustand":                       ["Zustand",             "State management",            "Data"],
  "zod":                           ["Zod",                 "Schema validation",           "Data"],
  "nanoid":                        ["nanoid",              "ID generation",               "Data"],
  "gray-matter":                   ["gray-matter",         "Note frontmatter",            "Data"],
  "chokidar":                      ["chokidar",            "File watcher",                "Data"],
  "date-fns":                      ["date-fns",            "Date utilities",              "Data"],

  // ── AI ──────────────────────────────────────────────────────────────────────
  "@modelcontextprotocol/sdk":     ["MCP SDK",             "Agent protocol",              "AI"],
  "ai":                            ["Vercel AI SDK",       "AI streaming utilities",      "AI"],

  // ── UI ──────────────────────────────────────────────────────────────────────
  "tailwindcss":                   ["Tailwind CSS",        "Styling",                     "UI"],
  "tailwind-merge":                ["tailwind-merge",      "Class merge utility",         "UI"],
  "clsx":                          ["clsx",                "Class utilities",             "UI"],
  "lucide-react":                  ["Lucide",              "Icons",                       "UI"],
  "cmdk":                          ["cmdk",                "Command palette",             "UI"],
  "react-day-picker":              ["react-day-picker",    "Date picker",                 "UI"],
  "@dnd-kit/core":                 ["dnd-kit",             "Drag & drop",                 "UI"],
  "@dnd-kit/sortable":             ["dnd-kit sortable",    "Sortable lists",              "UI"],
  "@radix-ui/react-dialog":        ["Radix Dialog",        "Modal dialogs",               "UI"],
  "@radix-ui/react-dropdown-menu": ["Radix Dropdown",      "Dropdown menus",              "UI"],
  "@radix-ui/react-tooltip":       ["Radix Tooltip",       "Tooltips",                    "UI"],
  "@radix-ui/react-popover":       ["Radix Popover",       "Popovers",                    "UI"],
  "@radix-ui/react-select":        ["Radix Select",        "Select menus",                "UI"],
  "@radix-ui/react-context-menu":  ["Radix Context Menu",  "Context menus",               "UI"],

  // ── Agent ───────────────────────────────────────────────────────────────────
  "node-pty":                      ["node-pty",             "PTY process spawning",        "Agent"],
  "@xterm/xterm":                  ["xterm.js",             "Terminal emulator",           "Agent"],
  "@xterm/addon-fit":              ["xterm addon-fit",      "Terminal auto-resize",        "Agent"],
  "@xterm/addon-unicode11":        ["xterm addon-unicode11","Unicode 11 / emoji support",  "Agent"],
  "parse-diff":                    ["parse-diff",           "Git diff parser",             "Agent"],
  "@codemirror/language-data":     ["CM language-data",     "Language auto-detection",     "Agent"],

  // ── Editor ──────────────────────────────────────────────────────────────────
  "@codemirror/view":              ["CodeMirror 6",        "Note editor",                 "Editor"],
  "@codemirror/state":             ["CodeMirror state",    "Editor state model",          "Editor"],
  "@codemirror/search":            ["CM search",           "In-editor find/replace panel","Editor"],
  "@codemirror/commands":          ["CM commands",         "Keybindings & history",       "Editor"],
  "@codemirror/language":          ["CM language",         "Syntax highlighting support", "Editor"],
  "@codemirror/lang-markdown":     ["CM Markdown",         "Markdown language support",   "Editor"],
  "@lezer/highlight":              ["Lezer",               "Syntax tree highlighter",     "Editor"],
  "react-markdown":                ["react-markdown",      "Markdown render",             "Editor"],
  "remark-gfm":                    ["remark-gfm",          "GFM support",                 "Editor"],
  "remark-breaks":                 ["remark-breaks",       "Hard line breaks",            "Editor"],
  "remark-math":                   ["remark-math",         "Math expression parsing",     "Editor"],
  "rehype-katex":                  ["rehype-katex",        "Math render (KaTeX)",         "Editor"],
  "katex":                         ["KaTeX",               "LaTeX math renderer",         "Editor"],
  "mermaid":                       ["Mermaid",             "Diagram render",              "Editor"],
  "lowlight":                      ["lowlight",            "Syntax highlighting",         "Editor"],

  // ── Visualisation ───────────────────────────────────────────────────────────
  "@xyflow/react":                 ["React Flow",          "Node canvas (Idea Flow)",     "Visualisation"],
  "@dagrejs/dagre":                ["Dagre",               "Graph auto-layout",           "Visualisation"],
  "react-force-graph-2d":          ["react-force-graph-2d","Force graph (Knowledge Graph)","Visualisation"],
  "d3":                            ["D3",                  "Analytics & graph visualisation","Visualisation"],
  "d3-hierarchy":                  ["d3-hierarchy",        "Radial tree layout",          "Visualisation"],
  "d3-zoom":                       ["d3-zoom",             "SVG pan & zoom",              "Visualisation"],
  "d3-selection":                  ["d3-selection",        "SVG DOM helpers",             "Visualisation"],
  "d3-sankey":                     ["d3-sankey",           "Sankey pipeline diagram",     "Visualisation"],
};

// Canonical category order for display
const CATEGORY_ORDER = ["Platform", "Data", "AI", "UI", "Editor", "Agent", "Visualisation"];

// All deps (runtime + dev) — in an Electron app there's no meaningful runtime/dev split
const allDeps = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
};

// ── Packages excluded from the Open Source Licenses list ──────────────────────
// These are build/test/dev-only tools that are never shipped to end users.
// Type stubs (@types/*) are excluded automatically via the prefix check below.
const DEV_ONLY = new Set([
  "@playwright/test",
  "@tailwindcss/postcss",
  "@vitest/coverage-v8",
  "@yao-pkg/pkg",
  "concurrently",
  "cross-env",
  "electron-builder",
  "esbuild",
  "eslint",
  "eslint-config-next",
  "vitest",
  "wait-on",
]);

function resolvePackage(name) {
  const pkgPath = path.join(root, "node_modules", name, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return null;
  }
}

const stack = [];
const allLicenses = [];

for (const [name] of Object.entries(allDeps)) {
  const resolved = resolvePackage(name);
  if (!resolved) continue;

  const version = resolved.version ?? "unknown";
  const license = resolved.license ?? resolved.licenses?.[0]?.type ?? "unknown";

  // Exclude dev/build-only tools and all @types/* stubs from the shipped list
  const isDevOnly = DEV_ONLY.has(name) || name.startsWith("@types/");
  if (!isDevOnly) {
    allLicenses.push({ name, version, license });
  }

  if (ROLE_MAP[name]) {
    const [label, role, category] = ROLE_MAP[name];
    stack.push({ name, label, version, role, category, license });
  }
}

// Sort stack by ROLE_MAP insertion order within each category
const roleKeys = Object.keys(ROLE_MAP);
stack.sort((a, b) => roleKeys.indexOf(a.name) - roleKeys.indexOf(b.name));
allLicenses.sort((a, b) => a.name.localeCompare(b.name));

// Group stack by category in canonical order
const stackByCategory = CATEGORY_ORDER.map((category) => ({
  category,
  entries: stack.filter((e) => e.category === category),
})).filter((g) => g.entries.length > 0);

const output = { stack, stackByCategory, allLicenses, generatedAt: new Date().toISOString() };

const outDir = path.join(root, "src", "generated");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "licenses.json");
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

console.log(`[generate-licenses] Written ${stack.length} stack entries across ${stackByCategory.length} categories and ${allLicenses.length} license entries to src/generated/licenses.json`);
