/**
 * Fixture eval: old mobile blend (dense min-max 50/50 with a term-match lexical
 * score) vs the shared hybrid ranker. Dense scores are HAND-ASSIGNED to mimic
 * what a small embedding model does (strong on paraphrase and topic, weak on
 * opaque ids, near-duplicates cluster together) — a regression guard for the
 * ranking logic, not a benchmark of any embedding model. Run with `-t eval` and
 * the table is printed.
 */
import { describe, it, expect } from "vitest";
import { bm25Scores, hybridRank, queryTerms } from "./hybrid";

interface Doc { id: string; group: string; title: string; text: string }
const docs: Doc[] = [
  { id: "ingress", group: "ingress", title: "Kubernetes ingress setup", text: "Install the nginx ingress controller, expose the service and configure routing rules for the cluster." },
  { id: "ingress-copy", group: "ingress-copy", title: "Kubernetes ingress setup (copy)", text: "Install the nginx ingress controller, expose the service and configure routing rules for the cluster." },
  { id: "ingress-draft", group: "ingress-draft", title: "Ingress setup draft", text: "Install the nginx ingress controller and configure routing rules for the cluster, draft." },
  { id: "tls", group: "tls", title: "TLS certificates with cert-manager", text: "Issue and renew certificates automatically so https works on every route." },
  { id: "err4021", group: "err4021", title: "ERR-4021 payment timeout runbook", text: "When the gateway returns ERR-4021, check the upstream queue and retry with backoff." },
  { id: "billing", group: "billing", title: "Billing outage postmortem", text: "Customers were double charged for two hours after a retry storm; refunds issued." },
  { id: "okr", group: "okr", title: "Quarterly OKR planning", text: "Objectives and key results for next quarter, owners and review cadence." },
  { id: "onboard", group: "onboard", title: "Onboarding checklist", text: "Accounts, laptop, access to the repo and the first week schedule." },
  { id: "search", group: "search", title: "Semantic search design", text: "Hybrid retrieval with embeddings and keyword matching for notes and tasks." },
  { id: "garden", group: "garden", title: "Garden irrigation schedule", text: "Water the beds at dawn; drip lines on the south side every other day." },
  { id: "retro", group: "retro", title: "Retro 2026-09", text: "What went well, what to improve, action items for the sprint." },
  { id: "recipe", group: "recipe", title: "Sourdough recipe", text: "Flour, water, salt and a mature starter; bulk ferment overnight." },
  { id: "infra-log", group: "infra-log", title: "Infra log October", text: "Weekly infra log. Disk alerts on the build box were noisy. INC-88231 root cause: the wildcard certificate expired on the edge proxy, renewal job had been disabled in the migration. Added a calendar reminder and a monitor for expiry." },
  { id: "incident-handbook", group: "incident-handbook", title: "Incident response handbook", text: "How we run incidents: roles, severity levels, communication templates and the postmortem process." },
  { id: "security", group: "security", title: "Security policy", text: "Passwords, MFA and device encryption. Service credentials must be rotated every 90 days and stored in the vault." },
  { id: "access", group: "access", title: "Access control overview", text: "Roles and permissions, how to request access, and who approves what." },
];
// A realistic corpus is mostly unrelated notes. Deterministic filler (distinct
// dense scores 0.05..0.20) keeps the rank tail long, as RRF assumes.
const FILLER_WORDS = ["travel", "budget", "invoice", "reading", "workout", "taxes", "holiday", "camera", "podcast", "movie", "meeting", "after", "look", "planning", "weekly"];
for (let i = 0; i < 80; i++) {
  docs.push({
    id: `filler-${i}`, group: `filler-${i}`, title: `${FILLER_WORDS[i % 15]} ${FILLER_WORDS[(i * 7) % 15]} ${i}`,
    text: `${FILLER_WORDS[(i * 3) % 15]} ${FILLER_WORDS[(i * 5) % 15]} notes number ${i} written after the fact`,
  });
}
const fillerDense = (id: string) => (id.startsWith("filler-") ? 0.05 + ((Number(id.slice(7)) * 37) % 80) / 80 * 0.15 : 0.1);

interface Q { name: string; kind: string; query: string; relevant: string[]; dense: Record<string, number> }
// Missing ids get a low background dense score.
const queries: Q[] = [
  { name: "opaque error id", kind: "exact", query: "ERR-4021", relevant: ["err4021"],
    dense: { billing: 0.55, err4021: 0.4, onboard: 0.38, okr: 0.35, search: 0.3, retro: 0.3 } },
  { name: "runbook by title", kind: "exact", query: "payment timeout runbook", relevant: ["err4021"],
    dense: { err4021: 0.6, billing: 0.58, okr: 0.3, retro: 0.28 } },
  { name: "feature name", kind: "exact", query: "cert-manager", relevant: ["tls"],
    dense: { ingress: 0.5, "ingress-copy": 0.5, tls: 0.46, "ingress-draft": 0.44 } },
  { name: "paraphrase: double charge", kind: "paraphrase", query: "why were customers billed twice", relevant: ["billing"],
    dense: { billing: 0.72, err4021: 0.5, okr: 0.2, retro: 0.25 } },
  { name: "paraphrase: watering", kind: "paraphrase", query: "when do I look after the plants", relevant: ["garden"],
    dense: { garden: 0.66, recipe: 0.3, onboard: 0.28 } },
  { name: "paraphrase: finding things", kind: "paraphrase", query: "how can I find notes by meaning", relevant: ["search"],
    dense: { search: 0.7, okr: 0.3, retro: 0.3 } },
  { name: "id inside a long note body", kind: "exact", query: "INC-88231 root cause", relevant: ["infra-log"],
    dense: { "incident-handbook": 0.7, billing: 0.5, "infra-log": 0.42, retro: 0.4, err4021: 0.38 } },
  { name: "rare phrase in body", kind: "exact", query: "rotated every 90 days", relevant: ["security"],
    dense: { access: 0.6, security: 0.55, onboard: 0.4 } },
  { name: "near-dup sections", kind: "dup", query: "set up kubernetes ingress", relevant: ["ingress", "tls"],
    dense: { ingress: 0.8, "ingress-copy": 0.8, "ingress-draft": 0.78, tls: 0.62, err4021: 0.3 } },
  { name: "near-dup + related", kind: "dup", query: "ingress routing rules and https", relevant: ["ingress", "tls"],
    dense: { ingress: 0.74, "ingress-copy": 0.74, "ingress-draft": 0.72, tls: 0.6 } },
];

// ---- old ranker (verbatim recipe of mobile/src/notes/embeddings.ts before) ----
const OLD_STOP = new Set(["the","and","for","how","does","did","was","were","are","you","your","with","what","why","who","can","our","this","that","into","from","work","works","use","used","using","get","got","has","have","a","an"]);
const oldTerms = (q: string) => [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !OLD_STOP.has(t)))];
function oldRank(q: Q): string[] {
  const terms = oldTerms(q.query);
  const hits = docs.map((d) => {
    let lex = 0;
    for (const t of terms) lex += d.title.toLowerCase().includes(t) ? 2 : d.text.toLowerCase().includes(t) ? 1 : 0;
    return { id: d.id, sem: q.dense[d.id] ?? fillerDense(d.id), lex: terms.length ? lex / (terms.length * 2) : 0 };
  });
  const lo = Math.min(...hits.map((h) => h.sem));
  const span = Math.max(Math.max(...hits.map((h) => h.sem)) - lo, 1e-6);
  return hits.map((h) => ({ id: h.id, r: 0.5 * ((h.sem - lo) / span) + 0.5 * h.lex })).sort((a, b) => b.r - a.r).map((h) => h.id);
}

function newRank(q: Q): string[] {
  const terms = queryTerms(q.query);
  const kw = bm25Scores(terms, docs);
  return hybridRank(q.query, docs.map((d, i) => ({
    id: d.id, group: d.group, title: d.title, text: d.text, dense: q.dense[d.id] ?? fillerDense(d.id), keyword: kw[i],
  })), { maxK: 5 }).map((r) => r.id);
}

const K = 3;
function metrics(q: Q, ranked: string[]) {
  const top = ranked.slice(0, K);
  const firstRel = ranked.findIndex((id) => q.relevant.includes(id));
  return {
    recall: q.relevant.filter((r) => top.includes(r)).length / q.relevant.length,
    rr: firstRel < 0 ? 0 : 1 / (firstRel + 1),
    // Copies of the same content occupying the top-K beyond the first.
    dups: top.filter((id) => id.startsWith("ingress")).length > 1 ? top.filter((id) => id.startsWith("ingress")).length - 1 : 0,
  };
}

describe("eval: old blend vs shared hybrid ranker", () => {
  const rows = queries.map((q) => ({ q, o: metrics(q, oldRank(q)), n: metrics(q, newRank(q)), oldTop: oldRank(q).slice(0, K), newTop: newRank(q).slice(0, K) }));
  const avg = (f: (r: (typeof rows)[number]) => number, kind?: string) => {
    const sel = rows.filter((r) => !kind || r.q.kind === kind);
    return sel.reduce((a, r) => a + f(r), 0) / sel.length;
  };

  it("prints the comparison table", () => {
    const lines = ["query | kind | old top3 | new top3 | old RR→new RR | old R@3→new R@3"];
    for (const r of rows) {
      lines.push(`${r.q.query} | ${r.q.kind} | ${r.oldTop.join(",")} | ${r.newTop.join(",")} | ${r.o.rr.toFixed(2)}→${r.n.rr.toFixed(2)} | ${r.o.recall.toFixed(2)}→${r.n.recall.toFixed(2)}`);
    }
    for (const kind of ["exact", "paraphrase", "dup"]) {
      lines.push(`MEAN ${kind}: MRR ${avg((r) => r.o.rr, kind).toFixed(2)}→${avg((r) => r.n.rr, kind).toFixed(2)}, R@3 ${avg((r) => r.o.recall, kind).toFixed(2)}→${avg((r) => r.n.recall, kind).toFixed(2)}`);
    }
    lines.push(`MEAN all: MRR ${avg((r) => r.o.rr).toFixed(2)}→${avg((r) => r.n.rr).toFixed(2)}, R@3 ${avg((r) => r.o.recall).toFixed(2)}→${avg((r) => r.n.recall).toFixed(2)}, dup slots in top3 ${avg((r) => r.o.dups).toFixed(2)}→${avg((r) => r.n.dups).toFixed(2)}`);
    console.log(lines.join("\n"));
  });

  it("new ranker is no worse on any query class and better overall", () => {
    for (const kind of ["exact", "paraphrase", "dup"]) {
      expect(avg((r) => r.n.rr, kind)).toBeGreaterThanOrEqual(avg((r) => r.o.rr, kind));
      expect(avg((r) => r.n.recall, kind)).toBeGreaterThanOrEqual(avg((r) => r.o.recall, kind));
    }
    expect(avg((r) => r.n.dups)).toBeLessThan(avg((r) => r.o.dups));
  });
});
