/**
 * Seeded synthetic workspace for the knowledge-graph benchmarks
 * (`graph.bench.ts`, run with `npm run bench:graph`).
 *
 * Deterministic: the same size + seed always produces the same rows, so
 * numbers are comparable across branches. Shapes follow what the graph
 * pipeline actually reads: markdown bodies (headings, [[wikilinks]], plain
 * mentions of other titles), tags, explicit note↔note / note↔card links, card
 * assignees and a pre-filled relationship_cache (computing it for real is
 * O(notes²) and is benchmarked separately on the single-save path).
 *
 * Test/bench-only: constructs its own in-memory Database, which the
 * bootstrap-site rule exempts for test code.
 */

import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./schema";
import { createWorkspace, createProject, createNote, createColumn, createCard, createTag } from "./queries";

export interface GraphFixture {
  db: Database.Database;
  workspaceId: string;
  noteIds: string[];
  cardIds: string[];
}

export interface GraphFixtureOptions {
  notes: number;
  /** Average note body size in bytes (default 3000). */
  avgNoteBytes?: number;
  /** Cards per 10 notes (default 3). */
  cardsPer10Notes?: number;
  seed?: number;
}

/** mulberry32 — tiny, fast, deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ["ka", "ro", "mi", "tan", "vel", "or", "si", "lu", "den", "pra", "qu", "ex", "zo", "bri", "mar", "tel", "nus", "ga", "fen", "ith"];

export function buildGraphFixture(opts: GraphFixtureOptions): GraphFixture {
  const rand = rng(opts.seed ?? 42);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const avgBytes = opts.avgNoteBytes ?? 3000;
  const cardCount = Math.round((opts.notes * (opts.cardsPer10Notes ?? 3)) / 10);
  const projectCount = Math.max(2, Math.round(opts.notes / 250));

  // Vocabulary with a Zipf-like draw: a few very common words, a long tail —
  // so keyword (Jaccard) similarity lands on a realistic minority of pairs.
  const vocab: string[] = [];
  for (let i = 0; i < 3000; i++) {
    const n = 2 + Math.floor(rand() * 3);
    let w = "";
    for (let j = 0; j < n; j++) w += pick(SYLLABLES);
    vocab.push(w + (i % 7 === 0 ? "" : String.fromCharCode(97 + (i % 26))));
  }
  const word = () => vocab[Math.floor(Math.pow(rand(), 2.2) * vocab.length)];
  const words = (n: number) => Array.from({ length: n }, word).join(" ");

  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  const workspaceId = "ws-bench";
  const noteIds: string[] = [];
  const cardIds: string[] = [];
  const titles: string[] = [];

  db.transaction(() => {
    createWorkspace(db, { id: workspaceId, name: "Bench" });

    const tagIds: string[] = [];
    for (let i = 0; i < 40; i++) {
      const id = `tag-${i}`;
      createTag(db, { id, workspaceId, name: `tag ${words(1)}`, color: "#888888" });
      tagIds.push(id);
    }

    const projects: { id: string; columnId: string }[] = [];
    for (let p = 0; p < projectCount; p++) {
      const id = `proj-${p}`;
      createProject(db, { id, workspaceId, name: `Project ${words(2)}` });
      const columnId = `col-${p}`;
      createColumn(db, { id: columnId, projectId: id, workspaceId, name: "Todo" });
      projects.push({ id, columnId });
    }

    for (let i = 0; i < opts.notes; i++) titles.push(`${words(2 + Math.floor(rand() * 2))} ${i}`);

    for (let i = 0; i < opts.notes; i++) {
      // Body: headings + paragraphs, a couple of [[wikilinks]] and plain
      // mentions of other titles (co-mention), sized around avgBytes (±50%).
      const target = avgBytes * (0.5 + rand());
      const parts: string[] = [];
      let size = 0;
      while (size < target) {
        let chunk: string;
        const r = rand();
        if (r < 0.1) chunk = `## ${words(3)}`;
        else if (r < 0.14) chunk = `See [[${pick(titles)}]] for context.`;
        else if (r < 0.18) chunk = `Related to ${pick(titles)} and **${words(2)}**.`;
        else chunk = words(20 + Math.floor(rand() * 40)) + ".";
        parts.push(chunk);
        size += chunk.length + 2;
      }
      const id = `note-${i}`;
      const project = projects[i % projects.length];
      const noteTags = rand() < 0.6 ? [pick(tagIds), pick(tagIds)] : [];
      createNote(db, {
        id,
        projectId: project.id,
        workspaceId,
        title: titles[i],
        content: parts.join("\n\n"),
        tagIds: [...new Set(noteTags)],
      });
      noteIds.push(id);
    }

    const linkNotes = db.prepare("UPDATE notes SET linked_note_ids = ? WHERE id = ?");
    for (const id of noteIds) {
      if (rand() < 0.3) linkNotes.run(JSON.stringify([pick(noteIds), pick(noteIds)].filter((x) => x !== id)), id);
    }

    const assignees = ["alex", "sam", "jo", "kai", "rin", "lee"];
    const linkCard = db.prepare("UPDATE task_cards SET linked_note_ids = ? WHERE id = ?");
    for (let i = 0; i < cardCount; i++) {
      const id = `card-${i}`;
      const project = projects[i % projects.length];
      createCard(db, {
        id,
        columnId: project.columnId,
        projectId: project.id,
        workspaceId,
        title: `Task ${words(3)} ${i}`,
        description: words(30 + Math.floor(rand() * 60)),
        assignee: rand() < 0.5 ? pick(assignees) : undefined,
        tagIds: rand() < 0.4 ? [pick(tagIds)] : [],
      });
      if (rand() < 0.4) linkCard.run(JSON.stringify([pick(noteIds)]), id);
      cardIds.push(id);
    }

    // ~6 cached auto edges per note, spread across the auto types.
    const types = ["co-mention", "keyword", "wikilink", "semantic", "keyword", "semantic"];
    const cache = db.prepare(
      `INSERT OR IGNORE INTO relationship_cache (source_id, target_id, type, weight, computed_at)
       VALUES (?, ?, ?, ?, 0)`,
    );
    for (const a of noteIds) {
      for (const type of types) {
        const b = pick(noteIds);
        if (a === b) continue;
        const [s, t] = a < b ? [a, b] : [b, a];
        cache.run(s, t, type, Math.round(rand() * 100) / 100);
      }
    }
  })();

  return { db, workspaceId, noteIds, cardIds };
}
