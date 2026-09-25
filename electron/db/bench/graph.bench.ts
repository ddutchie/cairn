/**
 * Knowledge-graph benchmarks. Run with `npm run bench:graph`.
 *
 * Covers the costs a user pays while working with a large workspace:
 *   - getKnowledgeGraph: what every graph (re)load runs on the Electron main
 *     process, plus the serialized payload size that crosses IPC.
 *   - JSON.stringify(graph): the renderer's "did anything change" signature,
 *     computed on every background refresh.
 *   - computeAutoRelationships([id]): the synchronous work each note save
 *     triggers on the main process.
 *
 * Fixtures are seeded (graph-fixture.ts) so numbers compare across
 * branches. Sizes are kept modest so a run finishes in about a minute.
 */

import { bench, describe } from "vitest";
import { buildGraphFixture, type GraphFixture } from "./graph-fixture";
import { getKnowledgeGraph, computeAutoRelationships } from "../graph-queries";

const SIZES = [1000, 5000] as const;

const fixtures = new Map<number, GraphFixture>();
function fixture(n: number): GraphFixture {
  let f = fixtures.get(n);
  if (!f) {
    f = buildGraphFixture({ notes: n });
    fixtures.set(n, f);
    const g = getKnowledgeGraph(f.db, f.workspaceId);
    const mb = (Buffer.byteLength(JSON.stringify(g)) / 1e6).toFixed(1);
    console.log(`[graph-bench] ${n} notes → ${g.nodes.length} nodes, ${g.edges.length} edges, ${mb} MB payload`);
  }
  return f;
}

const opts = { time: 2000, warmupIterations: 2 };

for (const n of SIZES) {
  describe(`${n} notes`, () => {
    const f = fixture(n);
    const graph = getKnowledgeGraph(f.db, f.workspaceId);
    let i = 0;

    bench("getKnowledgeGraph (all projects)", () => {
      getKnowledgeGraph(f.db, f.workspaceId);
    }, opts);

    bench("renderer change signature (JSON.stringify)", () => {
      JSON.stringify(graph);
    }, opts);

    // computeAutoRelationships rewrites relationship_cache rows, so it runs on
    // its own fixture: the read benches above always see the seeded edge set,
    // whatever the bench order or filter.
    const saveFixture = buildGraphFixture({ notes: n });
    bench("save path: computeAutoRelationships([note])", () => {
      // Rotate through notes so the pass isn't just re-reading a warm row.
      computeAutoRelationships(saveFixture.db, saveFixture.workspaceId, [saveFixture.noteIds[i++ % saveFixture.noteIds.length]]);
    }, { time: 2000, warmupIterations: 1 });
  });
}
