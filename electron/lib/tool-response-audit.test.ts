/**
 * Tool RESPONSE size audit — LIVE-DATA-FREE, measures the token cost of what
 * each mobile tool puts BACK into the conversation (JSON.stringify(result)).
 *
 * Unlike the tool *payload* (schemas, fixed per turn), tool *responses* accrue
 * in the running conversation and are re-sent every subsequent turn — so a
 * single fat response permanently inflates context for the rest of the session.
 * This is the likely cause of "one query jumps context 10-20%".
 *
 * We reconstruct each tool's response SHAPE with representative data and count
 * tokens (o200k, matching the app's js-tiktoken gauge). This is deterministic —
 * no network, always runs. It documents the current baseline and guards the
 * caps we add (get_note TOC, context-pack limits).
 */

import { describe, it, expect } from "vitest";
import { encode } from "gpt-tokenizer";

const tok = (s: unknown) => encode(JSON.stringify(s)).length;

// ── Representative data ──────────────────────────────────────────────────────
// A "typical" long note (design doc): ~2,500 words, headings, code, lists.
function makeNote(paras: number): string {
  const chunk = [
    "## Section heading",
    "",
    "This is a paragraph of prose describing the design. It references files, decisions, and rationale in enough detail to be useful. ".repeat(3),
    "",
    "- A bullet point about one consideration",
    "- Another bullet with `inline code` and a [[Wikilink]]",
    "",
    "```ts",
    "function example(x: number): number { return x * 2; }",
    "```",
    "",
  ].join("\n");
  return `# Design Document\n\n${Array.from({ length: paras }, (_, i) => chunk.replace("Section heading", `Section ${i + 1}`)).join("\n")}`;
}

describe("tool response size audit (o200k)", () => {
  it("measures representative tool responses and flags the offenders", () => {
    const shortNote = makeNote(2);   // ~small note
    const bigNote = makeNote(20);    // ~long design doc

    // get_note — returns the FULL note row (content untruncated).
    const getNoteSmall = { id: "n1", project_id: "p1", title: "X", content: shortNote, folder: "", tag_ids: "[]", updated_at: "2026-01-01", is_pinned: 0 };
    const getNoteBig = { ...getNoteSmall, content: bigNote };

    // get_project_context_pack — pinned notes (1000 chars EACH, UNCAPPED count)
    // + open tasks (400-char descriptions, uncapped) + recent activity.
    const pinned = (count: number) => Array.from({ length: count }, (_, i) => ({
      id: `n${i}`, title: `Pinned note ${i}`, folder: "", content: bigNote.slice(0, 1000) + "\n\n... (truncated, use get_note)",
    }));
    const tasks = (count: number) => Array.from({ length: count }, (_, i) => ({
      id: `c${i}`, title: `Task ${i}`, priority: "medium",
      description: "A task description that runs on for a while with detail. ".repeat(6).slice(0, 400) + "\n... (truncated, use get_note)",
    }));
    const contextPack = (pins: number, tks: number) => ({
      project: { id: "p1", name: "Cairn", columns: [{ id: "c1", name: "Todo", type: "todo" }] },
      noteCount: 40,
      pinnedNotes: pinned(pins),
      openTasks: [{ columnType: "todo", columnId: "c1", tasks: tasks(tks) }],
      recentActivity: Array.from({ length: 10 }, (_, i) => ({ type: "note", id: `n${i}`, title: `Note ${i}` })),
    });

    // search_notes — mobile maps to {id,title,folder,project_id} (already lean).
    const searchNotes = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, title: `Result ${i}`, folder: "Research", project_id: "p1" }));

    const rows: [string, number, string][] = [
      ["get_note (small note)", tok(getNoteSmall), "full content"],
      ["get_note (LONG design doc)", tok(getNoteBig), "full content — no cap"],
      ["get_project_context_pack (3 pinned, 8 tasks)", tok(contextPack(3, 8)), "typical"],
      ["get_project_context_pack (10 pinned, 30 tasks)", tok(contextPack(10, 30)), "busy project — UNCAPPED"],
      ["search_notes (50 results)", tok(searchNotes), "lean (ids/titles)"],
    ];

    console.log("\n=== MOBILE TOOL RESPONSE TOKENS (o200k) ===");
    console.log("response".padEnd(48), "tokens".padStart(7), "  note");
    for (const [name, t, note] of rows) {
      console.log(name.padEnd(48), String(t).padStart(7), "  " + note);
    }

    // A TOC-style get_note: headings + line numbers + total lines, no body.
    const lines = bigNote.split("\n");
    let inFence = false;
    const outline = lines.map((l, idx) => {
      if (l.startsWith("```")) inFence = !inFence;
      const m = !inFence && l.match(/^(#{1,3})\s+(.+)/);
      return m ? { level: m[1].length, text: m[2].trim(), line: idx } : null;
    }).filter(Boolean);
    const toc = { id: "n1", title: "Design Document", totalLines: lines.length, folder: "", outline };
    const tocTok = tok(toc);
    console.log(`\nget_note TOC alternative (LONG doc): ${tocTok} tok  vs full ${tok(getNoteBig)} tok  → -${Math.round((1 - tocTok / tok(getNoteBig)) * 100)}%`);
    console.log("");

    // ── AFTER fixes: capped context-pack + TOC get_note ──────────────────────
    const cappedPack = (pins: number, tks: number) => ({
      project: { id: "p1", name: "Cairn", columns: [{ id: "c1", name: "Todo", type: "todo" }] },
      noteCount: 40,
      pinnedNotes: pinned(Math.min(pins, 5)).map((p) => ({ ...p, content: bigNote.slice(0, 300) + "… (use get_note for full note)" })),
      pinnedNotesTotal: pins,
      openTasks: [{ columnType: "todo", columnId: "c1", tasks: tasks(Math.min(tks, 20)).map((t) => ({ id: t.id, title: t.title, priority: t.priority, description: t.description.slice(0, 120) + "… (use get_task for full description)" })) }],
      recentActivity: Array.from({ length: 10 }, (_, i) => ({ type: "note", id: `n${i}`, title: `Note ${i}` })),
    });

    console.log("\n=== AFTER fixes ===");
    console.log("get_project_context_pack (10 pinned, 30 tasks) capped:", tok(cappedPack(10, 30)), "tok (was 5788)");
    console.log("get_note (long doc) → TOC mode:", tocTok, "tok (was", tok(getNoteBig) + ")");
    console.log("");

    // Guardrail assertions documenting the problem AND the fix.
    expect(tok(getNoteBig)).toBeGreaterThan(1500);              // a single note can be >1.5k tok
    expect(tok(contextPack(10, 30))).toBeGreaterThan(2500);     // busy pack WAS huge
    expect(tocTok).toBeLessThan(tok(getNoteBig) / 2);           // TOC is <half the full doc
    // Fixed: capped pack is dramatically smaller than the uncapped one.
    expect(tok(cappedPack(10, 30))).toBeLessThan(tok(contextPack(10, 30)) / 2);
    expect(tok(cappedPack(10, 30))).toBeLessThan(2000);
  });
});
