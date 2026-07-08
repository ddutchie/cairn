/**
 * On-device semantic search for notes.
 *
 * Mirrors the desktop bge-small pipeline's *shape* (section-level embeddings,
 * incremental hash-gated reindex, brute-force cosine over L2-normalised vectors)
 * but runs entirely on-device via Apple's NLContextualEmbedding
 * (modules/apple-embeddings). Because those vectors live in Apple's own space —
 * NOT interchangeable with desktop's — the index is built and queried per-device
 * and never syncs (the note_embeddings table has no capture trigger).
 *
 * Everything degrades gracefully: when the native module is unavailable (older
 * iOS, Android, Expo Go), reindex is a no-op and search returns [] so callers
 * fall back to keyword search.
 */

import {
  AppleEmbeddings,
  isAppleEmbeddingsSupported,
  embedTexts,
  type AppleEmbeddingsInfo,
} from "@modules/apple-embeddings";
import {
  listEmbeddableNotes,
  getNoteEmbeddingRows,
  getWorkspaceEmbeddingRows,
  upsertNoteEmbedding,
  deleteNoteEmbeddingsFrom,
  deleteNoteEmbeddings,
  embeddedNoteIds,
  clearAllEmbeddings,
  noteTitleById,
  getNoteForEmbedding,
  listWorkspaceIds,
  type EmbeddableNote,
} from "@/db/queries";

// Chunk very long sections so we stay near the model's token budget; chunk
// vectors are averaged + renormalised (same approach as desktop).
const CHUNK_CHARS = 3500;
const CHUNK_OVERLAP = 200;
const EMBED_BATCH = 8;

// --- model metadata cache -------------------------------------------------

let _info: AppleEmbeddingsInfo | null = null;

/** Model metadata (cached). Null when embeddings can't run on this device. */
export async function embeddingsInfo(): Promise<AppleEmbeddingsInfo | null> {
  if (_info) return _info;
  if (!AppleEmbeddings) return null;
  try {
    const ready = await AppleEmbeddings.ensureAssets();
    if (!ready) return null;
    _info = await AppleEmbeddings.info();
    return _info;
  } catch {
    return null;
  }
}

/** Stable index-invalidation key: identity + revision + dimension. */
function modelKey(info: AppleEmbeddingsInfo): string {
  return `${info.modelIdentifier}@${info.revision}:${info.dimension}`;
}

// --- text helpers ---------------------------------------------------------

export interface NoteSection {
  idx: number;
  title: string;
  text: string;
}

const HEADER_RE = /^(#{1,6})\s+(.+)$/;

/** Split a note into `#`/`##`-delimited sections (matches desktop splitIntoSections). */
export function splitIntoSections(noteTitle: string, content: string): NoteSection[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const lines = trimmed.split("\n");
  const sections: NoteSection[] = [];
  let currentTitle = noteTitle || "Untitled";
  let currentLines: string[] = [];
  let idx = 0;
  const flush = () => {
    const text = currentLines.join("\n").trim();
    if (text) {
      sections.push({ idx, title: currentTitle, text });
      idx++;
    }
  };
  for (const line of lines) {
    const m = line.match(HEADER_RE);
    if (m && m[1].length <= 2) {
      flush();
      currentTitle = m[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();
  if (sections.length === 0) {
    sections.push({ idx: 0, title: noteTitle || "Untitled", text: trimmed });
  }
  return sections;
}

/** Fast non-cryptographic digest (FNV-1a) for change detection only. */
function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** The exact text we embed + hash for a section (title gives it grounding). */
function sectionEmbedText(noteTitle: string, sec: NoteSection): string {
  return `${noteTitle}\n\n## ${sec.title}\n${sec.text}`;
}

function chunk(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + CHUNK_CHARS));
    i += CHUNK_CHARS - CHUNK_OVERLAP;
  }
  return out;
}

// --- vector math ----------------------------------------------------------

/** Dot product of two equal-length L2-normalised vectors == cosine similarity. */
function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Subtract the corpus centroid from `v` and L2-renormalise (see semanticSearch). */
function centerAndNormalise(v: Float32Array, centroid: Float32Array): Float32Array {
  const dim = v.length;
  const out = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    out[i] = v[i] - centroid[i];
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-9) for (let i = 0; i < dim; i++) out[i] /= norm;
  return out;
}

/**
 * Map a centred cosine score (roughly −0.4..0.8 in practice) to a 0–1 display
 * value. Clamps negatives to 0 and stretches the useful positive range so the
 * UI shows a meaningful spread instead of everything reading ~90%.
 */
function displayScore(centered: number): number {
  if (centered <= 0) return 0;
  // A strong match centres around ~0.4–0.8; scale so 0.5 → ~0.85, 0.8 → ~1.0.
  const scaled = Math.min(1, centered / 0.8);
  return Math.round(scaled * 1000) / 1000;
}

function averageAndNormalise(vecs: Float32Array[]): Float32Array {
  const dim = vecs[0].length;
  const acc = new Float32Array(dim);
  for (const v of vecs) for (let i = 0; i < dim; i++) acc[i] += v[i];
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    acc[i] /= vecs.length;
    norm += acc[i] * acc[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-9) for (let i = 0; i < dim; i++) acc[i] /= norm;
  return acc;
}

/** Embed one (possibly long) piece of text into a single normalised vector. */
async function embedOne(text: string, dim: number): Promise<Float32Array | null> {
  const chunks = chunk(text);
  const rows = await embedTexts(chunks, dim);
  if (rows.length === 0) return null;
  return rows.length === 1 ? rows[0] : averageAndNormalise(rows);
}

// --- reindex --------------------------------------------------------------

let reindexing = false;
const singleInFlight = new Set<string>();

/**
 * Re-embed a single note incrementally: only sections whose (hash, model)
 * changed are re-embedded; removed trailing sections are pruned; an emptied
 * note has its rows deleted. Cheap to call on every save. No-op when embeddings
 * are unavailable or disabled.
 */
export async function reindexNote(noteId: string): Promise<void> {
  if (!isAppleEmbeddingsSupported()) return;
  const info = await embeddingsInfo();
  if (!info) return;
  const note = getNoteForEmbedding(noteId);
  if (!note || !note.content) {
    deleteNoteEmbeddings(noteId);
    return;
  }
  await embedNoteInner(note, info);
}

/**
 * Embed/prune one note's sections. Serialised per note via `singleInFlight` so
 * a save-triggered reindexNote and a workspace pass can't race the same note's
 * delete/upsert rows. The guard wraps the entire embed/delete/prune flow, so
 * concurrent callers for the same id are dropped (last write wins is fine —
 * both compute the same result from current content).
 */
async function embedNoteInner(note: EmbeddableNote, info: AppleEmbeddingsInfo): Promise<void> {
  if (singleInFlight.has(note.id)) return;
  singleInFlight.add(note.id);
  try {
    const key = modelKey(info);
    const sections = splitIntoSections(note.title, note.content ?? "");
    if (sections.length === 0) {
      deleteNoteEmbeddings(note.id);
      return;
    }
    const existing = new Map(getNoteEmbeddingRows(note.id).map((r) => [r.section_idx, r]));

    for (const sec of sections) {
      const text = sectionEmbedText(note.title, sec);
      const hash = hashText(text);
      const prev = existing.get(sec.idx);
      if (prev && prev.content_hash === hash && prev.model === key) continue; // unchanged
      const vec = await embedOne(text, info.dimension);
      if (!vec) continue;
      upsertNoteEmbedding({
        noteId: note.id,
        sectionIdx: sec.idx,
        workspaceId: note.workspace_id,
        model: key,
        sectionTitle: sec.title,
        contentHash: hash,
        vector: Array.from(vec),
      });
    }
    // Prune sections that no longer exist (note shrank).
    deleteNoteEmbeddingsFrom(note.id, sections.length);
  } finally {
    singleInFlight.delete(note.id);
  }
}

export interface ReindexProgress {
  done: number;
  total: number;
}

/**
 * Full workspace reindex. Skips unchanged sections, so a repeat run is cheap.
 * If the model identity changed since the last run, the whole index is cleared
 * first (Apple can rev the on-device model). Serialised via `reindexing`.
 */
export async function reindexWorkspace(
  workspaceId: string,
  onProgress?: (p: ReindexProgress) => void,
): Promise<void> {
  if (reindexing || !isAppleEmbeddingsSupported()) return;
  reindexing = true;
  try {
    const info = await embeddingsInfo();
    if (!info) return;
    const key = modelKey(info);

    // Model changed → the whole space shifted; wipe and rebuild.
    const sample = getWorkspaceEmbeddingRows(workspaceId)[0];
    if (sample && sample.model !== key) clearAllEmbeddings();

    const notes = listEmbeddableNotes(workspaceId);
    const liveIds = new Set(notes.map((n) => n.id));
    let done = 0;
    for (let i = 0; i < notes.length; i += EMBED_BATCH) {
      const batch = notes.slice(i, i + EMBED_BATCH);
      // Notes are embedded sequentially (native embed is already batched per
      // note); this keeps memory + CPU steady on-device.
      for (const n of batch) {
        await embedNoteInner(n, info);
        done++;
      }
      onProgress?.({ done, total: notes.length });
    }
    // Drop embeddings for notes that were deleted since the last pass.
    for (const id of embeddedNoteIds(workspaceId)) {
      if (!liveIds.has(id)) deleteNoteEmbeddings(id);
    }
  } finally {
    reindexing = false;
  }
}

// --- search ---------------------------------------------------------------

export interface SemanticHit {
  noteId: string;
  title: string;
  sectionTitle: string;
  score: number;
}

// Small LRU-ish cache of recent query vectors (queries repeat as the user types).
const queryCache = new Map<string, Float32Array>();
const QUERY_CACHE_MAX = 32;

/**
 * Brute-force cosine search: embed the query, dot-product against every stored
 * section vector, keep the best-scoring section per note, return top-`k`. Empty
 * result (not an error) when embeddings are unavailable so the UI can fall back.
 */
export async function semanticSearch(
  workspaceId: string,
  query: string,
  k = 20,
): Promise<SemanticHit[]> {
  const q = query.trim();
  if (!q || !isAppleEmbeddingsSupported()) return [];
  const info = await embeddingsInfo();
  if (!info) return [];

  let qvec = queryCache.get(q);
  if (!qvec) {
    const v = await embedOne(q, info.dimension);
    if (!v) return [];
    qvec = v;
    if (queryCache.size >= QUERY_CACHE_MAX) {
      const first = queryCache.keys().next().value;
      if (first !== undefined) queryCache.delete(first);
    }
    queryCache.set(q, qvec);
  }

  // Parse all current-model doc vectors up front (needed for the centroid).
  const dim = info.dimension;
  const parsed: { noteId: string; vec: Float32Array; sectionTitle: string }[] = [];
  for (const row of getWorkspaceEmbeddingRows(workspaceId)) {
    if (row.model !== modelKey(info)) continue; // stale-model rows ignored
    try {
      const vec = Float32Array.from(JSON.parse(row.vector) as number[]);
      if (vec.length === dim) parsed.push({ noteId: row.note_id, vec, sectionTitle: row.section_title });
    } catch {
      // skip malformed row
    }
  }
  if (parsed.length === 0) return [];

  // Mean-pooled contextual vectors share a large common component that crushes
  // cosine into a narrow high band (every result reads ~90%). Subtracting the
  // corpus centroid from BOTH the query and each doc — then renormalising —
  // removes that shared direction and restores discrimination. (Verified in the
  // SwiftPM live tests: top-2 spread ~0.0005 → ~0.03+, and rankings flip to
  // correct.) The centroid is computed over the documents being searched.
  const centroid = new Float32Array(dim);
  for (const p of parsed) for (let i = 0; i < dim; i++) centroid[i] += p.vec[i];
  for (let i = 0; i < dim; i++) centroid[i] /= parsed.length;

  const cq = centerAndNormalise(qvec, centroid);

  const best = new Map<string, { score: number; sectionTitle: string }>();
  for (const p of parsed) {
    const score = dot(cq, centerAndNormalise(p.vec, centroid));
    const prev = best.get(p.noteId);
    if (!prev || score > prev.score) {
      best.set(p.noteId, { score, sectionTitle: p.sectionTitle });
    }
  }

  return [...best.entries()]
    .map(([noteId, v]) => ({
      noteId,
      title: noteTitleById(noteId),
      sectionTitle: v.sectionTitle,
      score: displayScore(v.score),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// --- semantic graph edges --------------------------------------------------

export interface SemanticEdge {
  source: string;
  target: string;
  weight: number;
}

// Mirrors desktop computeSemanticRelationships: keep the top-K nearest notes
// per note above a similarity floor, collapsed to canonical (src<tgt) pairs.
// Floor is on the CENTRED cosine (see semanticSearch) — raw mean-pooled cosine
// sits ~0.85+ for everything, so a raw 0.6 floor would connect all notes.
const SEMANTIC_FLOOR = 0.15;
const SEMANTIC_TOP_K = 5;

/**
 * All-pairs cosine over stored section vectors → best-per-note-pair semantic
 * edges. Vectors are centred by the corpus centroid before cosine (same fix as
 * semanticSearch) so edges reflect real topical similarity, not the shared
 * common component that makes every pair look ~90% alike. Empty when embeddings
 * are unavailable.
 */
export async function semanticEdges(workspaceId: string): Promise<SemanticEdge[]> {
  if (!isAppleEmbeddingsSupported()) return [];
  const info = await embeddingsInfo();
  if (!info) return [];
  const key = modelKey(info);
  const dim = info.dimension;

  // Collapse sections → one representative vector list per note, tracking best
  // pairwise similarity between notes.
  const rows = getWorkspaceEmbeddingRows(workspaceId).filter((r) => r.model === key);
  const raw: { noteId: string; vec: Float32Array }[] = [];
  for (const r of rows) {
    try {
      const v = Float32Array.from(JSON.parse(r.vector) as number[]);
      if (v.length === dim) raw.push({ noteId: r.note_id, vec: v });
    } catch {
      // skip malformed row
    }
  }
  if (raw.length === 0) return [];

  // Centre by the corpus centroid, then renormalise (restores discrimination).
  const centroid = new Float32Array(dim);
  for (const p of raw) for (let i = 0; i < dim; i++) centroid[i] += p.vec[i];
  for (let i = 0; i < dim; i++) centroid[i] /= raw.length;
  const vecs = raw.map((p) => ({ noteId: p.noteId, vec: centerAndNormalise(p.vec, centroid) }));

  // best[noteId] = list of {other, score}; we take top-K per note then union.
  const best = new Map<string, { other: string; score: number }[]>();
  const record = (a: string, b: string, score: number) => {
    const arr = best.get(a) ?? [];
    arr.push({ other: b, score });
    best.set(a, arr);
  };
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      if (vecs[i].noteId === vecs[j].noteId) continue; // same note, diff section
      const score = dot(vecs[i].vec, vecs[j].vec);
      if (score < SEMANTIC_FLOOR) continue;
      record(vecs[i].noteId, vecs[j].noteId, score);
      record(vecs[j].noteId, vecs[i].noteId, score);
    }
  }

  // Keep top-K per note, then dedupe to canonical pairs with the best score.
  const pairScore = new Map<string, number>();
  for (const [noteId, arr] of best) {
    arr.sort((x, y) => y.score - x.score);
    for (const { other, score } of arr.slice(0, SEMANTIC_TOP_K)) {
      const [s, t] = noteId < other ? [noteId, other] : [other, noteId];
      const pairKey = `${s}\u0000${t}`;
      const prev = pairScore.get(pairKey);
      if (prev === undefined || score > prev) pairScore.set(pairKey, score);
    }
  }

  const edges: SemanticEdge[] = [];
  for (const [pairKey, score] of pairScore) {
    const [source, target] = pairKey.split("\u0000");
    edges.push({ source, target, weight: Math.round(score * 100) / 100 });
  }
  return edges;
}

// --- index status store + orchestration -----------------------------------
//
// A tiny external store (useSyncExternalStore-friendly) so the UI can show a
// progress bar while the on-device index catches up — e.g. after a fresh
// install, an import, or a sync that pulled in new notes. Reindex is
// incremental (hash-gated), so a catch-up pass over an already-indexed
// workspace is cheap and finishes almost instantly.

export interface IndexStatus {
  /** True while a workspace catch-up pass is running. */
  running: boolean;
  done: number;
  total: number;
}

let indexStatus: IndexStatus = { running: false, total: 0, done: 0 };
const statusListeners = new Set<() => void>();

function setStatus(next: Partial<IndexStatus>) {
  indexStatus = { ...indexStatus, ...next };
  for (const l of statusListeners) l();
}

/** Subscribe to index-status changes (returns an unsubscribe fn). */
export function subscribeIndexStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/** Current index status snapshot (stable reference until it changes). */
export function getIndexStatus(): IndexStatus {
  return indexStatus;
}

let catchUpQueued = false;

/**
 * Bring the on-device index up to date across all workspaces. Safe to call at
 * startup and after each inbound sync — it coalesces concurrent calls, is a
 * no-op when embeddings are unavailable, and only re-embeds changed sections.
 * Publishes progress via the status store so a UI progress bar can react.
 */
export async function catchUpIndex(): Promise<void> {
  if (!isAppleEmbeddingsSupported()) return;
  // Coalesce: if a pass is running, mark that another is wanted and let the
  // current one loop again rather than overlapping work.
  if (indexStatus.running) {
    catchUpQueued = true;
    return;
  }
  do {
    catchUpQueued = false;
    setStatus({ running: true, done: 0, total: 0 });
    try {
      // Ensure model assets are present before counting work (first launch may
      // download them); bail quietly if they never arrive.
      const info = await embeddingsInfo();
      if (!info) {
        setStatus({ running: false });
        return;
      }
      const workspaces = listWorkspaceIds();
      for (const ws of workspaces) {
        await reindexWorkspace(ws, (p) => setStatus({ done: p.done, total: p.total }));
      }
    } catch (e) {
      console.warn("[embeddings] catch-up failed:", e);
    }
  } while (catchUpQueued);
  setStatus({ running: false });
}

