/**
 * Project links: pointers from a project to the places its material lives
 * (a Confluence space, Slack channels, a Jira project, a repo, a Figma file).
 *
 * The `ref` is the identifier a connector tool wants (a Confluence space key,
 * a Slack channel id, a Jira project key, `owner/repo`), so an agent can call
 * the tool directly instead of searching for the place from scratch.
 *
 * Pure and platform-neutral: used by the main process, the renderer and mobile.
 */

export const PROJECT_LINK_KINDS = [
  "confluence", "jira", "slack", "github", "figma", "notion", "linear", "drive", "url",
] as const;

export type ProjectLinkKind = (typeof PROJECT_LINK_KINDS)[number];

export interface ProjectLink {
  id: string;
  kind: ProjectLinkKind;
  label: string;
  url: string;
  /** What a connector tool takes: space key, channel id, project key, `owner/repo`. */
  ref?: string;
  /** What the link is for, in a line ("release notes live here"). */
  note?: string;
}

/** What a caller supplies; everything but the URL is filled in when missing. */
export interface ProjectLinkInput {
  url: string;
  kind?: ProjectLinkKind;
  label?: string;
  ref?: string;
  note?: string;
}

export const MAX_PROJECT_LINKS = 50;
const MAX_URL = 2000;
const MAX_LABEL = 120;
const MAX_REF = 200;
const MAX_NOTE = 300;

export const PROJECT_LINK_KIND_LABEL: Record<ProjectLinkKind, string> = {
  confluence: "Confluence",
  jira: "Jira",
  slack: "Slack",
  github: "GitHub",
  figma: "Figma",
  notion: "Notion",
  linear: "Linear",
  drive: "Google Drive",
  url: "Link",
};

export function isProjectLinkKind(value: unknown): value is ProjectLinkKind {
  return typeof value === "string" && (PROJECT_LINK_KINDS as readonly string[]).includes(value);
}

/** Parse an http(s) URL, or null. Anything else (javascript:, file:, bare text) is refused. */
function parseHttpUrl(raw: string): URL | null {
  const text = raw.trim();
  if (!text || text.length > MAX_URL) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The form two links are compared in: no scheme case, trailing slash or fragment. */
export function normalizeLinkUrl(raw: string): string | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}

export interface DetectedLink {
  kind: ProjectLinkKind;
  ref?: string;
  label: string;
}

/** Work out what a URL points at. Unknown hosts are a plain `url` link labelled by host. */
export function detectProjectLink(raw: string): DetectedLink | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));

  if (host.endsWith(".atlassian.net")) {
    if (parts[0] === "wiki") {
      const space = parts[1] === "spaces" ? parts[2] : undefined;
      return { kind: "confluence", ref: space, label: space ? `Confluence space ${space}` : "Confluence" };
    }
    const at = parts.indexOf("projects");
    const key = parts[0] === "browse" ? parts[1]?.replace(/-\d+$/, "")
      : parts[0] === "jira" && at >= 0 ? parts[at + 1] : undefined;
    if (parts[0] === "browse" || parts[0] === "jira") {
      return { kind: "jira", ref: key || undefined, label: key ? `Jira ${key}` : "Jira" };
    }
  }

  if (host === "slack.com" || host.endsWith(".slack.com")) {
    const channel = parts[0] === "archives" ? parts[1]
      : parts[0] === "client" ? parts[2] : undefined;
    return { kind: "slack", ref: channel, label: channel ? `Slack channel ${channel}` : "Slack" };
  }

  if (host === "github.com" || host === "www.github.com") {
    const repo = parts.length >= 2 ? `${parts[0]}/${parts[1].replace(/\.git$/, "")}` : undefined;
    return { kind: "github", ref: repo, label: repo ? `GitHub ${repo}` : "GitHub" };
  }

  if (host === "figma.com" || host.endsWith(".figma.com")) {
    return { kind: "figma", label: "Figma" };
  }
  if (host === "notion.so" || host.endsWith(".notion.so") || host.endsWith(".notion.site")) {
    return { kind: "notion", label: "Notion" };
  }
  if (host === "linear.app") {
    const team = parts[1] === "team" ? parts[2] : undefined;
    return { kind: "linear", ref: team, label: team ? `Linear ${team}` : "Linear" };
  }
  if (host === "docs.google.com" || host === "drive.google.com") {
    return { kind: "drive", label: "Google Drive" };
  }
  return { kind: "url", label: host.replace(/^www\./, "") };
}

function clip(value: string | undefined, max: number): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, max) : undefined;
}

/** Build a link from input, filling the kind, label and ref from the URL. Null when the URL is unusable. */
export function buildProjectLink(input: ProjectLinkInput, id: string): ProjectLink | null {
  const url = normalizeLinkUrl(input.url);
  const detected = detectProjectLink(input.url);
  if (!url || !detected) return null;
  const kind = isProjectLinkKind(input.kind) ? input.kind : detected.kind;
  const ref = clip(input.ref, MAX_REF) ?? (kind === detected.kind ? detected.ref : undefined);
  const note = clip(input.note, MAX_NOTE);
  return {
    id,
    kind,
    label: clip(input.label, MAX_LABEL) ?? (kind === detected.kind ? detected.label : PROJECT_LINK_KIND_LABEL[kind]),
    url,
    ...(ref ? { ref } : {}),
    ...(note ? { note } : {}),
  };
}

/** Read a stored `links` column back into valid links; bad rows are dropped. */
export function normalizeLinks(raw: unknown): ProjectLink[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectLink[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id || typeof r.url !== "string") continue;
    const link = buildProjectLink({
      url: r.url,
      kind: isProjectLinkKind(r.kind) ? r.kind : undefined,
      label: typeof r.label === "string" ? r.label : undefined,
      ref: typeof r.ref === "string" ? r.ref : undefined,
      note: typeof r.note === "string" ? r.note : undefined,
    }, r.id);
    if (!link || seen.has(link.url) || seen.has(`id:${link.id}`)) continue;
    seen.add(link.url);
    seen.add(`id:${link.id}`);
    out.push(link);
    if (out.length >= MAX_PROJECT_LINKS) break;
  }
  return out;
}

export interface LinkChangeResult {
  links: ProjectLink[];
  /** Inputs that were not usable URLs, or did not fit under the limit. */
  rejected: string[];
}

/**
 * Add links, keyed by URL: a URL already present is updated in place (its id is
 * kept; only the fields the input names change), so an agent can safely repeat a
 * call or refine a label without creating duplicates.
 */
export function addProjectLinks(existing: ProjectLink[], inputs: ProjectLinkInput[], newId: () => string): LinkChangeResult {
  const links = [...existing];
  const rejected: string[] = [];
  for (const input of inputs) {
    const url = normalizeLinkUrl(input.url ?? "");
    if (!url) { rejected.push(String(input.url ?? "")); continue; }
    const at = links.findIndex((l) => l.url === url);
    if (at >= 0) {
      const prev = links[at];
      const kindChanged = isProjectLinkKind(input.kind) && input.kind !== prev.kind;
      const merged = buildProjectLink({
        url,
        kind: isProjectLinkKind(input.kind) ? input.kind : prev.kind,
        label: input.label ?? prev.label,
        ref: input.ref ?? (kindChanged ? undefined : prev.ref),
        note: input.note ?? prev.note,
      }, prev.id);
      if (merged) links[at] = merged;
      continue;
    }
    if (links.length >= MAX_PROJECT_LINKS) { rejected.push(input.url); continue; }
    const link = buildProjectLink(input, newId());
    if (link) links.push(link); else rejected.push(input.url);
  }
  return { links, rejected };
}

export function removeProjectLinks(existing: ProjectLink[], ids: string[]): ProjectLink[] {
  const drop = new Set(ids);
  return existing.filter((l) => !drop.has(l.id));
}

/** The compact form an agent sees: no more than it needs to pick a tool and call it. */
export function linksForAgent(links: ProjectLink[] | undefined): Array<Omit<ProjectLink, "note"> & { note?: string }> {
  return (links ?? []).map(({ id, kind, label, url, ref, note }) => ({
    id, kind, label, url, ...(ref ? { ref } : {}), ...(note ? { note } : {}),
  }));
}

/** URLs found in free text (a project description), as import candidates. */
export function extractLinkCandidates(text: string | undefined, existing: ProjectLink[] = []): ProjectLinkInput[] {
  if (!text) return [];
  const have = new Set(existing.map((l) => l.url));
  const found = new Map<string, ProjectLinkInput>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>)\]"'`]+/gi)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    const url = normalizeLinkUrl(raw);
    if (!url || have.has(url) || found.has(url)) continue;
    found.set(url, { url: raw });
  }
  return [...found.values()];
}
