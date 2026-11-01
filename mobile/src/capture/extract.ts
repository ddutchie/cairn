import { queryTerms } from "@cairn/shared/notes/text";
import { userMessage } from "@/chat/agent";
import { resolveProvider } from "@/chat/providers";
import type { ChatProvider } from "@/chat/providers/types";
import { getMeta } from "@/db";
import { listWorkspaceIds } from "@/db/embeddings-queries";
import { getCairnContext, getNote, searchNotes } from "@/db/queries";
import { finalizeRanking, semanticSearch, type SemanticHit } from "@/notes/embeddings";
import { CAPTURE_RECENT_PROJECT_KEY } from "./commit";
import { buildCapturePrompt, FILE_CAPTURE_TOOL } from "./prompt";
import { fallbackProposal, normalizeProposal } from "./proposal";
import { scoreProjects, termOverlap } from "./rank";
import type { CaptureCandidate, CaptureContext, CaptureProposal } from "./types";

/** Past this the model is too slow for a "quick" capture: show the plain-note fallback. */
export const CAPTURE_AI_TIMEOUT_MS = 8000;
const CANDIDATE_COUNT = 6;
const QUERY_CHARS = 500;
const LEXICAL_TERMS = 5;

function localDate(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Related notes via embeddings; lexical title overlap when the index is empty or unavailable. */
async function findCandidates(text: string, knownProjects: ReadonlySet<string>): Promise<CaptureCandidate[]> {
  const query = text.slice(0, QUERY_CHARS);
  const toCandidate = (noteId: string, title: string, rank: number): CaptureCandidate | null => {
    const projectId = getNote(noteId)?.project_id;
    return projectId && knownProjects.has(projectId) ? { noteId, title, projectId, rank } : null;
  };

  let hits: SemanticHit[] = [];
  try {
    for (const ws of listWorkspaceIds()) hits.push(...(await semanticSearch(ws, query, CANDIDATE_COUNT)));
    hits = finalizeRanking(hits);
  } catch {
    hits = [];
  }
  const semantic = hits
    .slice(0, CANDIDATE_COUNT)
    .map((h) => toCandidate(h.noteId, h.title, h.rank))
    .filter((c): c is CaptureCandidate => c !== null);
  if (semantic.length > 0) return semantic;

  const terms = [...new Set(queryTerms(query).filter((t) => t.length >= 4))].slice(0, LEXICAL_TERMS);
  const seen = new Map<string, CaptureCandidate>();
  for (const term of terms) {
    for (const n of searchNotes(term)) {
      if (seen.has(n.id) || !knownProjects.has(n.project_id)) continue;
      seen.set(n.id, { noteId: n.id, title: n.title, projectId: n.project_id, rank: termOverlap(terms, n.title) });
    }
  }
  return [...seen.values()].sort((a, b) => b.rank - a.rank).slice(0, CANDIDATE_COUNT);
}

export async function buildCaptureContext(text: string): Promise<CaptureContext> {
  const raw = getCairnContext() as {
    projects: { id: string; name: string; columns: { id: string; name: string; type: string }[] }[];
    tags: { name: string }[];
  };
  const projects = raw.projects.map((p) => ({ id: p.id, name: p.name, columns: p.columns }));
  const known = new Set(projects.map((p) => p.id));
  const candidates = await findCandidates(text, known);
  const recent = getMeta(CAPTURE_RECENT_PROJECT_KEY);
  return {
    projects,
    tags: raw.tags.map((t) => t.name),
    candidates,
    projectScores: scoreProjects(candidates),
    recentProjectId: recent && known.has(recent) ? recent : null,
    today: localDate(),
  };
}

/** Run the model once and pull the `file_capture` arguments out of the stream. */
async function askModel(provider: ChatProvider, prompt: string, signal: AbortSignal): Promise<unknown> {
  const stream = provider.stream([userMessage(prompt)], { file_capture: FILE_CAPTURE_TOOL }, signal, { temperature: 0.2 });
  for await (const ev of stream) {
    if ((ev.type === "tool-input-available" || ev.type === "tool-executed") && ev.toolName === "file_capture") {
      const input = (ev as { input?: unknown }).input;
      if (typeof input === "string") {
        try {
          return JSON.parse(input);
        } catch {
          return null;
        }
      }
      return input;
    }
  }
  return null;
}

/**
 * Turn raw captured text into a validated proposal. Never throws for AI reasons:
 * no provider, offline, quota, timeout or junk output all degrade to a plain
 * note in the best-ranked (or most recent) project. Returns null only when the
 * workspace has no projects to file into.
 */
export async function captureExtract(text: string, outerSignal?: AbortSignal): Promise<CaptureProposal | null> {
  const clean = text.trim();
  const ctx = await buildCaptureContext(clean);
  if (ctx.projects.length === 0) return null;
  // Cancelled while the context was being built: don't spend a provider call on it.
  if (outerSignal?.aborted) return fallbackProposal(clean, ctx);

  // Resolve the provider before the timeout starts: the first request to a new
  // host shows the AI consent prompt, and reading it mustn't eat the AI budget.
  let provider: ChatProvider;
  try {
    provider = await resolveProvider();
  } catch {
    return fallbackProposal(clean, ctx);
  }
  if (outerSignal?.aborted) return fallbackProposal(clean, ctx);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTURE_AI_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort);
  try {
    const raw = await askModel(provider, buildCapturePrompt(clean, ctx), controller.signal);
    return normalizeProposal(raw, ctx, clean) ?? fallbackProposal(clean, ctx);
  } catch {
    return fallbackProposal(clean, ctx);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
    // Stop the stream if the provider keeps going after the tool call; no-op once finished.
    controller.abort();
  }
}
