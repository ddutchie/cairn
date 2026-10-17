import type { CaptureCandidate, CaptureProject, ProjectScore } from "./types";

/** Position weights for a project's best-matching notes: the top hit dominates. */
const WEIGHTS = [1, 0.5, 0.25];

/** Below this a project is a guess, so we prefer the most recently active one. */
export const CONFIDENT_SCORE = 0.3;

/**
 * Collapse note-level similarity hits into per-project scores. A project's score
 * is a weighted sum of its three best hits, so one strong match beats a
 * scatter of weak ones, but several related notes still lift a project.
 */
export function scoreProjects(
  candidates: readonly Pick<CaptureCandidate, "projectId" | "rank">[],
): ProjectScore[] {
  const byProject = new Map<string, number[]>();
  for (const c of candidates) {
    if (!c.projectId || !Number.isFinite(c.rank)) continue;
    const list = byProject.get(c.projectId) ?? [];
    list.push(c.rank);
    byProject.set(c.projectId, list);
  }
  const scores: ProjectScore[] = [];
  for (const [projectId, ranks] of byProject) {
    ranks.sort((a, b) => b - a);
    const score = ranks.slice(0, WEIGHTS.length).reduce((sum, r, i) => sum + Math.max(r, 0) * WEIGHTS[i], 0);
    scores.push({ projectId, score });
  }
  return scores.sort((a, b) => b.score - a.score);
}

/**
 * Choose the destination project: the best-scoring project when it clears
 * `CONFIDENT_SCORE`, else the most recently active one, else the first project.
 * Returns null only when there are no projects at all.
 */
export function pickProject(ctx: {
  projects: readonly Pick<CaptureProject, "id">[];
  projectScores: readonly ProjectScore[];
  recentProjectId: string | null;
}): { projectId: string; confident: boolean } | null {
  const known = new Set(ctx.projects.map((p) => p.id));
  const best = ctx.projectScores.find((s) => known.has(s.projectId));
  if (best && best.score >= CONFIDENT_SCORE) return { projectId: best.projectId, confident: true };
  if (ctx.recentProjectId && known.has(ctx.recentProjectId)) {
    return { projectId: ctx.recentProjectId, confident: false };
  }
  if (best) return { projectId: best.projectId, confident: false };
  const first = ctx.projects[0];
  return first ? { projectId: first.id, confident: false } : null;
}

/**
 * Cheap lexical similarity (0–1) between query terms and a title, used when the
 * embeddings index is empty or unavailable: the share of query terms the title contains.
 */
export function termOverlap(terms: readonly string[], title: string): number {
  if (terms.length === 0) return 0;
  const hay = title.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t.toLowerCase())) hits += 1;
  return hits / terms.length;
}
