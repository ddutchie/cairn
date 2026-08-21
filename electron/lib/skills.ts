/**
 * Skill loader for the Cairn native coding agent.
 *
 * Implements the industry-standard SKILL.md convention compatible with
 * OpenCode, Cline, and Claude Code. Skills live in:
 *
 *   Project-local (highest precedence, first match wins per name):
 *     .cairn/skills/<name>/SKILL.md
 *     .opencode/skills/<name>/SKILL.md
 *     .cline/skills/<name>/SKILL.md
 *     .claude/skills/<name>/SKILL.md
 *     .agents/skills/<name>/SKILL.md
 *
 *   Global (fallback):
 *     ~/.config/cairn/skills/<name>/SKILL.md
 *     ~/.opencode/skills/<name>/SKILL.md
 *
 * Three-level loading model (token-efficient):
 *   1. Metadata (name + description) — always injected into system prompt as XML
 *   2. Full body — loaded on demand when the agent calls the `skill` tool
 *   3. Bundled resources — co-located files the agent can read via the `read` tool
 *
 * Name rules: ^[a-z0-9]+(-[a-z0-9]+)*$ (1–64 chars, kebab-case, matches dir)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import matter from "gray-matter";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Parsed SKILL.md metadata (frontmatter only — always available). */
export interface SkillMeta {
  /** Kebab-case name, validated against dir name. */
  name: string;
  /** One-line description shown to the model for relevance decisions. */
  description: string;
  /** Optional SPDX license identifier. */
  license?: string;
  /** Agent compatibility tag (e.g. "opencode", "cline", "cairo"). */
  compatibility?: string;
  /** Arbitrary string-to-string metadata. */
  metadata?: Record<string, string>;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** Absolute path to the skill directory (for bundled resource access). */
  dirPath: string;
}

/** Full skill content returned when the agent calls the `skill` tool. */
export interface SkillContent extends SkillMeta {
  /** Raw markdown body of SKILL.md (everything below the frontmatter). */
  body: string;
  /** Relative paths of co-located resource files (docs/, templates/, scripts/). */
  resources: string[];
}

// ── Name validation ───────────────────────────────────────────────────────────

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name) && name.length >= 1 && name.length <= 64;
}

// ── Discovery paths ───────────────────────────────────────────────────────────

const SKILL_SUBDIRS = [
  path.join(".cairn", "skills"),
  path.join(".opencode", "skills"),
  path.join(".cline", "skills"),
  path.join(".claude", "skills"),
  path.join(".agents", "skills"),
];

/**
 * Walk from `dir` up to the filesystem root, stopping early at a git root.
 * Returns all ancestor directories in order (closest first).
 */
function walkUpToRoot(dir: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (true) {
    dirs.push(current);
    // Stop at git root so we don't escape the project
    if (fs.existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current || current === root) break;
    current = parent;
  }

  return dirs;
}

/**
 * Returns ordered list of skill root directories to scan for a given cwd.
 * Walks up from cwd to the git root so skills placed at the project root
 * are found even when cwd is a subdirectory (e.g. packages/web/).
 * Project-local paths take precedence; global paths are checked last.
 */
function getSkillSearchPaths(cwd: string): string[] {
  const ancestors = walkUpToRoot(cwd);

  // For each ancestor dir, add all skill subdir variants (in ancestor order,
  // so closer dirs win). Deduplicate in case cwd is already the git root.
  const seen = new Set<string>();
  const local: string[] = [];
  for (const dir of ancestors) {
    for (const sub of SKILL_SUBDIRS) {
      const p = path.join(dir, sub);
      if (!seen.has(p)) {
        seen.add(p);
        local.push(p);
      }
    }
  }

  const home = os.homedir();
  const global = [
    path.join(home, ".config", "cairn", "skills"),
    path.join(home, ".opencode", "skills"),
  ];

  return [...local, ...global];
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/** Parse a SKILL.md file and return its metadata. Returns null if invalid. */
function parseSkillFile(filePath: string, dirName: string): SkillMeta | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    return null;
  }

  const { data } = parsed;

  // Validate required fields
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";

  if (!name || !description) return null;
  if (!isValidSkillName(name)) return null;

  // Name must match the directory name for unambiguous lookup
  if (name !== dirName) return null;

  return {
    name,
    description,
    license:       typeof data.license       === "string" ? data.license       : undefined,
    compatibility: typeof data.compatibility === "string" ? data.compatibility : undefined,
    metadata:      data.metadata && typeof data.metadata === "object"
                     ? (data.metadata as Record<string, string>)
                     : undefined,
    filePath,
    dirPath: path.dirname(filePath),
  };
}

// ── Resource discovery ────────────────────────────────────────────────────────

const RESOURCE_SUBDIRS = ["docs", "templates", "scripts"];

/**
 * Returns relative paths (from skill dir) of all co-located resource files.
 * Only looks in docs/, templates/, scripts/ subdirectories.
 */
function listSkillResources(dirPath: string): string[] {
  const resources: string[] = [];

  for (const sub of RESOURCE_SUBDIRS) {
    const subDir = path.join(dirPath, sub);
    if (!fs.existsSync(subDir)) continue;

    try {
      const entries = fs.readdirSync(subDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          resources.push(path.join(sub, entry.name));
        }
      }
    } catch {
      // Skip unreadable subdirectories
    }
  }

  return resources;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Discover all available skills for the given working directory.
 *
 * Scans all search paths in order. First occurrence of a skill name wins
 * (project-local takes precedence over global).
 *
 * Only metadata is loaded — the body is not read until `loadSkill()` is called.
 */
export function discoverSkills(cwd: string): SkillMeta[] {
  const seen = new Set<string>();
  const skills: SkillMeta[] = [];

  for (const searchPath of getSkillSearchPaths(cwd)) {
    if (!fs.existsSync(searchPath)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(searchPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirName = entry.name;
      if (seen.has(dirName)) continue; // project takes precedence over global

      const skillFile = path.join(searchPath, dirName, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;

      const meta = parseSkillFile(skillFile, dirName);
      if (!meta) continue;

      seen.add(dirName);
      skills.push(meta);
    }
  }

  return skills;
}

/**
 * Load the full body and resource list for a skill by name.
 *
 * Called when the agent invokes the `skill` tool. Returns null if the skill
 * is not found or cannot be read.
 */
export function loadSkill(name: string, skills: SkillMeta[]): SkillContent | null {
  const meta = skills.find((s) => s.name === name);
  if (!meta) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(meta.filePath, "utf8");
  } catch {
    return null;
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    return null;
  }

  return {
    ...meta,
    body:      parsed.content.trim(),
    resources: listSkillResources(meta.dirPath),
  };
}

