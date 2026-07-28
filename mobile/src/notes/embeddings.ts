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
  noteTextByIds,
  getNoteForEmbedding,
  listWorkspaceIds,
  listEmbeddableCards,
  getCardEmbeddingRows,
  getWorkspaceCardEmbeddingRows,
  upsertCardEmbedding,
  deleteCardEmbeddingsFrom,
  deleteCardEmbeddings,
  embeddedCardIds,
  cardTitlesByIds,
  cardTextByIds,
  type EmbeddableNote,
  type EmbeddableCard,
} from "@/db/queries";
import { splitIntoSections, type NoteSection } from "@cairn/shared/notes/sections";
import { dotNormalized as dot } from "@cairn/shared/embeddings/vector";

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

// --- lexical (keyword) scoring for hybrid search --------------------------

// Mean-pooled contextual embeddings capture broad topic/style but not keyword
// salience, so on a homogeneous corpus pure cosine buries the obviously-correct
// note (verified on the real 70-note DB: "how does semantic search work" ranked
// the semantic-search note 36th). Production semantic search is therefore hybrid
// — dense (vectors) + sparse (keywords). We blend a title-weighted lexical score
// with the centred cosine; α=SEMANTIC_WEIGHT was tuned on the real corpus so
// every query with a clear target note ranks it #1.
const SEMANTIC_WEIGHT = 0.5; // weight on the dense (embedding) score; 1-α on lexical

const STOPWORDS = new Set([
  "the", "and", "for", "how", "does", "did", "was", "were", "are", "you", "your",
  "with", "what", "why", "who", "can", "our", "this", "that", "into", "from",
  "work", "works", "use", "used", "using", "get", "got", "has", "have", "a", "an",
]);

/** Distinct, meaningful (>2 chars, non-stopword) lowercased query terms. */
function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 2 && !STOPWORDS.has(raw)) seen.add(raw);
  }
  return [...seen];
}

/**
 * Title-weighted lexical score in [0,1]: each query term matched in the note
 * title counts double, in the body once. This is what lets a note literally
 * titled "…semantic search" win the query "how does semantic search work".
 */
function lexicalScore(terms: string[], title: string, body: string): number {
  if (terms.length === 0) return 0;
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (t.includes(term)) score += 2;
    else if (b.includes(term)) score += 1;
  }
  return score / (terms.length * 2);
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
      // Isolate per-section embed failures: the native embedder can throw on
      // certain inputs (e.g. a body of only symbols/links that tokenises to
      // nothing, so it returns a mismatched count — see modules/apple-embeddings
      // embedTexts). Without this guard one bad note aborted the ENTIRE
      // workspace pass (the throw unwound to catchUpIndex's outer catch), so
      // every note after it was left unindexed. Skip the section and carry on.
      let vec: Float32Array | null = null;
      try {
        vec = await embedOne(text, info.dimension);
      } catch (e) {
        console.warn(`[embeddings] skipped note ${note.id} section ${sec.idx}:`, e);
        continue;
      }
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
        try {
          await embedNoteInner(n, info);
        } catch (e) {
          // One note must never abort the whole pass (belt-and-suspenders on top
          // of the per-section guard) — the rest still get indexed.
          console.warn(`[embeddings] note ${n.id} failed to index:`, e);
        }
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
  /** Human-readable similarity (centred cosine, 0–1) shown in the UI. */
  score: number;
  /** Blended dense+lexical score used for ORDERING. Callers merging results
   *  across workspaces must call finalizeRanking() on the merged list first, so
   *  the min-max normalisation spans the combined corpus (see finalizeRanking). */
  rank: number;
  /** What `noteId` refers to. Defaults to "note"; task search sets "card" so
   *  callers can route to /note or /card. */
  kind?: "note" | "card";
  /** Raw centred-cosine (dense) score, retained so a merged multi-workspace list
   *  can be re-normalised globally before blending. */
  _sem: number;
  /** Raw title-weighted lexical score (already 0–1, corpus-independent). */
  _lex: number;
}

/**
 * Compute the ordering `rank` for a set of hits from their raw dense/lexical
 * components, min-max normalising the DENSE scores across the WHOLE set (so the
 * result is comparable across whatever corpus the set spans). Callers that merge
 * per-workspace results MUST call this on the merged list before sorting/slicing
 * — otherwise each workspace's `rank` was normalised only within its own corpus
 * and isn't comparable (a small workspace's top hit would outrank a large one's
 * unfairly). Mutates and returns the same array, sorted by `rank` desc.
 */
export function finalizeRanking<T extends SemanticHit>(hits: T[]): T[] {
  if (hits.length === 0) return hits;
  const sems = hits.map((h) => h._sem);
  const lo = Math.min(...sems);
  const hi = Math.max(...sems);
  const span = Math.max(hi - lo, 1e-6);
  for (const h of hits) {
    const semN = (h._sem - lo) / span;
    h.rank = SEMANTIC_WEIGHT * semN + (1 - SEMANTIC_WEIGHT) * h._lex;
  }
  hits.sort((a, b) => b.rank - a.rank);
  return hits;
}

// Small LRU-ish cache of recent query vectors (queries repeat as the user types).
const queryCache = new Map<string, Float32Array>();
const QUERY_CACHE_MAX = 32;

/**
 * Shared hybrid-search pipeline for notes and task cards. Notes and cards use an
 * identical ranking recipe — query-vector cache, corpus-centroid centring,
 * best-centred-cosine section per entity, min-max normalisation, and a
 * dense+lexical blend — so both delegate here to prevent divergence. The caller
 * supplies only what differs: the row source, the id→text/title lookups, and the
 * result `kind` tag. See semanticSearch for the reasoning behind each step.
 */
async function rankSemantic(
  workspaceId: string,
  query: string,
  k: number | undefined,
  opts: {
    getRows: (workspaceId: string) => import("../db/queries").EmbeddingRow[];
    getText: (ids: string[]) => Map<string, { title: string; text: string }>;
    getTitle: (ids: string[]) => (id: string) => string;
    kind: "note" | "card";
  },
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
  const parsed: { entityId: string; vec: Float32Array; sectionTitle: string }[] = [];
  for (const row of opts.getRows(workspaceId)) {
    if (row.model !== modelKey(info)) continue; // stale-model rows ignored
    try {
      const vec = Float32Array.from(JSON.parse(row.vector) as number[]);
      if (vec.length === dim) parsed.push({ entityId: row.note_id, vec, sectionTitle: row.section_title });
    } catch {
      // skip malformed row
    }
  }
  if (parsed.length === 0) return [];

  // Mean-pooled contextual vectors share a large common component that crushes
  // cosine into a narrow high band (every result reads ~90%). Subtracting the
  // corpus centroid from BOTH the query and each doc — then renormalising —
  // removes that shared direction and restores discrimination.
  const centroid = new Float32Array(dim);
  for (const p of parsed) for (let i = 0; i < dim; i++) centroid[i] += p.vec[i];
  for (let i = 0; i < dim; i++) centroid[i] /= parsed.length;

  const cq = centerAndNormalise(qvec, centroid);

  // Best (highest) centred-cosine section score per entity.
  const bestSem = new Map<string, { score: number; sectionTitle: string }>();
  for (const p of parsed) {
    const score = dot(cq, centerAndNormalise(p.vec, centroid));
    const prev = bestSem.get(p.entityId);
    if (!prev || score > prev.score) {
      bestSem.set(p.entityId, { score, sectionTitle: p.sectionTitle });
    }
  }
  if (bestSem.size === 0) return [];

  const ids = [...bestSem.keys()];
  const texts = opts.getText(ids);
  const titleOf = opts.getTitle(ids);
  const terms = queryTerms(q);

  // Build hits carrying the RAW dense (centred cosine) + lexical components.
  // finalizeRanking computes the blended `rank` with a min-max over this set;
  // when a caller merges multiple workspaces it re-runs finalizeRanking over the
  // combined list so normalisation spans the whole corpus (see finalizeRanking).
  const hits: SemanticHit[] = ids.map((id) => {
    const sem = bestSem.get(id)!;
    const info2 = texts.get(id);
    const lex = lexicalScore(terms, info2?.title ?? "", info2?.text ?? "");
    return {
      noteId: id, // SemanticHit reuses `noteId`; for cards it's the card id
      title: titleOf(id),
      sectionTitle: sem.sectionTitle,
      // Display uses the raw centred cosine; ordering uses the blended `rank`.
      score: displayScore(sem.score),
      rank: 0, // set by finalizeRanking below
      kind: opts.kind,
      _sem: sem.score,
      _lex: lex,
    };
  });
  finalizeRanking(hits); // sorts by rank desc (single-corpus normalisation here)
  // Only slice when the caller asks. When merging across workspaces, callers
  // must merge the FULL lists and call finalizeRanking ONCE, then slice.
  return typeof k === "number" ? hits.slice(0, k) : hits;
}

/**
 * Brute-force cosine search over notes: embed the query, rank every stored note
 * section, keep the best per note, hybrid-rerank, return top-`k`. Empty result
 * (not an error) when embeddings are unavailable so the UI can fall back.
 *
 * NOTE on slicing: only slice when the caller asks. When searching across
 * multiple workspaces (one DB per source can hold several), callers must merge
 * the FULL ranked candidate lists and slice ONCE after a combined re-rank —
 * slicing per-workspace here would drop a note that ranks low in its own
 * workspace but high globally (the "correct note buried at #36" case).
 */
export async function semanticSearch(
  workspaceId: string,
  query: string,
  k?: number,
): Promise<SemanticHit[]> {
  return rankSemantic(workspaceId, query, k, {
    getRows: getWorkspaceEmbeddingRows,
    getText: noteTextByIds,
    getTitle: () => noteTitleById,
    kind: "note",
  });
}

// --- task-card index + search ---------------------------------------------

const singleCardInFlight = new Set<string>();

/** Embed/prune one card's sections (title + description). Mirrors embedNoteInner. */
async function embedCardInner(card: EmbeddableCard, info: AppleEmbeddingsInfo): Promise<void> {
  if (singleCardInFlight.has(card.id)) return;
  singleCardInFlight.add(card.id);
  try {
    const key = modelKey(info);
    // Always embed at least the title; description is the body. Fall back to the
    // title when the description is null OR blank/whitespace — otherwise a card
    // with a non-null but empty description would split into zero sections and
    // never index, even though the liveCards count (which trims) treats it as
    // embeddable. Keeping this in sync avoids a permanently-short index count.
    const body = card.description?.trim() ? card.description : card.title;
    const sections = splitIntoSections(card.title, body);
    if (sections.length === 0) {
      deleteCardEmbeddings(card.id);
      return;
    }
    const existing = new Map(getCardEmbeddingRows(card.id).map((r) => [r.section_idx, r]));
    for (const sec of sections) {
      const text = sectionEmbedText(card.title, sec);
      const hash = hashText(text);
      const prev = existing.get(sec.idx);
      if (prev && prev.content_hash === hash && prev.model === key) continue;
      // Same per-section isolation as notes: a native embed failure on one card
      // must not abort the whole card pass. Skip and continue.
      let vec: Float32Array | null = null;
      try {
        vec = await embedOne(text, info.dimension);
      } catch (e) {
        console.warn(`[embeddings] skipped card ${card.id} section ${sec.idx}:`, e);
        continue;
      }
      if (!vec) continue;
      upsertCardEmbedding({
        cardId: card.id,
        sectionIdx: sec.idx,
        workspaceId: card.workspace_id,
        model: key,
        sectionTitle: sec.title,
        contentHash: hash,
        vector: Array.from(vec),
      });
    }
    deleteCardEmbeddingsFrom(card.id, sections.length);
  } finally {
    singleCardInFlight.delete(card.id);
  }
}

/** Full card reindex for a workspace (skips unchanged sections). */
export async function reindexWorkspaceCards(
  workspaceId: string,
  onProgress?: (p: ReindexProgress) => void,
): Promise<void> {
  if (!isAppleEmbeddingsSupported()) return;
  const info = await embeddingsInfo();
  if (!info) return;
  const cards = listEmbeddableCards(workspaceId);
  const liveIds = new Set(cards.map((c) => c.id));
  let done = 0;
  for (let i = 0; i < cards.length; i += EMBED_BATCH) {
    const batch = cards.slice(i, i + EMBED_BATCH);
    for (const c of batch) {
      try {
        await embedCardInner(c, info);
      } catch (e) {
        console.warn(`[embeddings] card ${c.id} failed to index:`, e);
      }
      done++;
    }
    onProgress?.({ done, total: cards.length });
  }
  for (const id of embeddedCardIds(workspaceId)) {
    if (!liveIds.has(id)) deleteCardEmbeddings(id);
  }
}

/**
 * Semantic search over TASK CARDS. Same centroid-centring + hybrid rerank as
 * semanticSearch (Apple's mean-pooled model needs both) — delegates to the
 * shared rankSemantic pipeline with card row/text/title sources. `k` optional:
 * omit to get the full ranked candidate list (callers merge across workspaces
 * then slice once — no per-workspace burying).
 */
export async function semanticSearchTasks(
  workspaceId: string,
  query: string,
  k?: number,
): Promise<SemanticHit[]> {
  return rankSemantic(workspaceId, query, k, {
    getRows: getWorkspaceCardEmbeddingRows,
    getText: cardTextByIds,
    getTitle: (ids) => {
      const titles = cardTitlesByIds(ids);
      return (id) => titles.get(id) ?? id;
    },
    kind: "card",
  });
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
 * All-pairs cosine over stored section vectors → best-per-entity-pair semantic
 * edges. Pools BOTH note sections and task-card sections into one corpus so
 * edges can form across kinds: note↔note, task↔task, and note↔task. Vectors are
 * centred by the (combined) corpus centroid before cosine (same fix as
 * semanticSearch) so edges reflect real topical similarity, not the shared
 * common component that makes every pair look ~90% alike. Empty when embeddings
 * are unavailable.
 *
 * Edges are keyed by entity id (note id or card id); the graph screen already
 * has both notes and cards as nodes, so no per-kind handling is needed there.
 */
export async function semanticEdges(workspaceId: string): Promise<SemanticEdge[]> {
  if (!isAppleEmbeddingsSupported()) return [];
  const info = await embeddingsInfo();
  if (!info) return [];
  const key = modelKey(info);
  const dim = info.dimension;

  // Collapse sections → representative vectors per entity (note OR card),
  // tracking best pairwise similarity between entities. Note and card rows share
  // the EmbeddingRow shape (card rows alias card_id AS note_id), so a single
  // combined pool is all we need — the entity id namespace is disjoint.
  const rows = [
    ...getWorkspaceEmbeddingRows(workspaceId),
    ...getWorkspaceCardEmbeddingRows(workspaceId),
  ].filter((r) => r.model === key);
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

export interface RelatedNote {
  noteId: string;
  title: string;
  /** Centred-cosine similarity to the source note (0–1). */
  score: number;
}

/**
 * Notes most similar to `noteId` by meaning — for a "Related notes" section on
 * the note detail screen. Centres all workspace vectors by the corpus centroid
 * (same discrimination fix as semanticSearch/semanticEdges), then keeps the best
 * section-to-section similarity between the source note and every other note.
 * Empty when embeddings are unavailable or the note isn't indexed yet.
 */
export async function relatedNotes(
  workspaceId: string,
  noteId: string,
  k = 5,
  floor = SEMANTIC_FLOOR,
): Promise<RelatedNote[]> {
  if (!isAppleEmbeddingsSupported()) return [];
  const info = await embeddingsInfo();
  if (!info) return [];
  const key = modelKey(info);
  const dim = info.dimension;

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

  const centroid = new Float32Array(dim);
  for (const p of raw) for (let i = 0; i < dim; i++) centroid[i] += p.vec[i];
  for (let i = 0; i < dim; i++) centroid[i] /= raw.length;

  const centred = raw.map((p) => ({ noteId: p.noteId, vec: centerAndNormalise(p.vec, centroid) }));
  const source = centred.filter((p) => p.noteId === noteId);
  if (source.length === 0) return []; // note not indexed

  // Best section-to-section similarity between the source note and each other note.
  const best = new Map<string, number>();
  for (const other of centred) {
    if (other.noteId === noteId) continue;
    let s = -2;
    for (const src of source) {
      const score = dot(src.vec, other.vec);
      if (score > s) s = score;
    }
    if (s < floor) continue;
    const prev = best.get(other.noteId);
    if (prev === undefined || s > prev) best.set(other.noteId, s);
  }

  return [...best.entries()]
    .map(([id, score]) => ({ noteId: id, title: noteTitleById(id), score: Math.round(score * 100) / 100 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
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
        await reindexWorkspaceCards(ws, (p) => setStatus({ done: p.done, total: p.total }));
      }
    } catch (e) {
      console.warn("[embeddings] catch-up failed:", e);
    }
  } while (catchUpQueued);
  setStatus({ running: false });
}

