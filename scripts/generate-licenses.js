#!/usr/bin/env node
/**
 * Cairn — License + stack generator
 *
 * Reads all dependencies from package.json, resolves their installed version
 * and license from node_modules/<pkg>/package.json, maps each to a human-
 * readable role, and writes src/generated/licenses.json.
 *
 * Run automatically by build.js before the Next.js build step.
 * Can also be run standalone: node scripts/generate-licenses.js
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

// ── Role map: package name → human label ─────────────────────────────────────
// Covers the packages we actually ship in the UI. Anything not listed here
// is treated as "infrastructure" and still included in the full license list
// but excluded from the "Stack" display grid.
const ROLE_MAP = {
  "electron":                    ["Electron",              "Desktop shell"],
  "next":                        ["Next.js",               "UI framework"],
  "react":                       ["React",                 "Renderer"],
  "typescript":                  ["TypeScript",            "Language"],
  "tailwindcss":                 ["Tailwind CSS",          "Styling"],
  "better-sqlite3":              ["better-sqlite3",        "Local database"],
  "gray-matter":                 ["gray-matter",           "Note frontmatter"],
  "chokidar":                    ["chokidar",              "File watcher"],
  "zustand":                     ["Zustand",               "State"],
  "@dnd-kit/core":               ["dnd-kit",               "Drag & drop (Kanban)"],
  "@xyflow/react":               ["React Flow",            "Node canvas (Idea Flow)"],
  "@dagrejs/dagre":              ["Dagre",                 "Graph auto-layout"],
  "react-force-graph-2d":        ["react-force-graph-2d",  "Force graph (Knowledge Graph)"],
  "d3-hierarchy":                ["d3-hierarchy",          "Radial tree layout"],
  "d3-zoom":                     ["d3-zoom",               "SVG pan & zoom"],
  "d3-selection":                ["d3-selection",          "SVG DOM helpers"],
  "lucide-react":                ["Lucide",                "Icons"],
  "@modelcontextprotocol/sdk":   ["MCP SDK",               "Agent protocol"],
  "esbuild":                     ["esbuild",               "Bundler"],
  "react-day-picker":            ["react-day-picker",      "Date picker"],
  "date-fns":                    ["date-fns",              "Date utilities"],
  "react-markdown":              ["react-markdown",        "Markdown render"],
  "remark-gfm":                  ["remark-gfm",            "GFM support"],
  "mermaid":                     ["Mermaid",               "Diagram render"],
  "lowlight":                    ["lowlight",              "Syntax highlighting"],
  "@codemirror/view":            ["CodeMirror 6",          "Note editor"],
  "electron-updater":            ["electron-updater",      "Auto-updater"],
  "zod":                         ["Zod",                   "Schema validation"],
  "@radix-ui/react-dialog":      ["Radix UI",              "Accessible primitives"],
  "nanoid":                      ["nanoid",                "ID generation"],
  "clsx":                        ["clsx",                  "Class utilities"],
};

// All deps (runtime + dev) — in an Electron app there's no meaningful runtime/dev split
const allDeps = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
};

function resolvePackage(name) {
  // Scoped packages live at node_modules/@scope/name
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

  const entry = { name, version, license };
  allLicenses.push(entry);

  if (ROLE_MAP[name]) {
    const [label, role] = ROLE_MAP[name];
    stack.push({ name, label, version, role, license });
  }
}

// Sort stack by ROLE_MAP insertion order, licenses alphabetically
stack.sort((a, b) => {
  const keys = Object.keys(ROLE_MAP);
  return keys.indexOf(a.name) - keys.indexOf(b.name);
});
allLicenses.sort((a, b) => a.name.localeCompare(b.name));

const output = { stack, allLicenses, generatedAt: new Date().toISOString() };

const outDir = path.join(root, "src", "generated");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "licenses.json");
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

console.log(`[generate-licenses] Written ${stack.length} stack entries and ${allLicenses.length} license entries to src/generated/licenses.json`);
