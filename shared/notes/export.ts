/**
 * Pure markdown export builders — shared by desktop (MCP/AI tools) and mobile.
 * No DB/native deps. Callers pass plain data objects assembled from their own
 * storage layer (snapshot on desktop, SQLite rows on mobile), so the markdown
 * shape stays identical across platforms.
 */

export interface ExportNoteInput {
  title: string;
  content: string;
  /** Resolved tag NAMES (not ids). */
  tagNames: string[];
  folder?: string;
}

export interface ExportCardInput {
  title: string;
  description?: string | null;
  priority: string;
  dueDate?: string | null;
  assignee?: string | null;
  tagNames: string[];
}

export interface ExportColumnInput {
  name: string;
  cards: ExportCardInput[];
}

export interface ExportProjectInput {
  name: string;
  description?: string | null;
  status: string;
  priority: string;
  dueDate?: string | null;
  /** Columns in board order; empty columns are skipped by the builder. */
  columns: ExportColumnInput[];
  /** Notes, already ordered by the caller (folder then title). */
  notes: ExportNoteInput[];
}

/** Strip a leading H1 that merely repeats the title, to avoid doubling it. */
function stripDuplicateTitleH1(content: string, title: string): string {
  // Match a leading `# Heading` with or without a trailing line ending, and
  // support both LF and CRLF. `[^\n\r]*` captures the heading text without
  // consuming the terminator so CRLF is handled by the optional `\r?\n+`.
  return content.replace(/^\s*#\s+([^\n\r]*)(?:\r?\n)*/, (m, heading: string) =>
    heading.trim() === title.trim() ? "" : m);
}

function tagLine(tagNames: string[]): string | null {
  return tagNames.length > 0 ? `**Tags:** ${tagNames.map((t) => `#${t}`).join(" ")}` : null;
}

/** A single note → self-contained markdown document. */
export function buildNoteMarkdown(note: ExportNoteInput): string {
  const lines: string[] = [`# ${note.title}`, ""];
  const tags = tagLine(note.tagNames);
  if (tags) lines.push(tags, "");
  lines.push(stripDuplicateTitleH1(note.content, note.title).trimEnd(), "");
  return lines.join("\n").trimEnd() + "\n";
}

/** A whole project → one markdown document (metadata + board + notes). */
export function buildProjectMarkdown(project: ExportProjectInput): string {
  const out: string[] = [`# ${project.name}`, ""];
  if (project.description) out.push(project.description, "");
  const meta = [`Status: ${project.status}`, `Priority: ${project.priority}`];
  if (project.dueDate) meta.push(`Due: ${project.dueDate}`);
  out.push(`_${meta.join(" · ")}_`, "");

  const nonEmptyCols = project.columns.filter((c) => c.cards.length > 0);
  if (nonEmptyCols.length > 0) {
    out.push("## Board", "");
    for (const col of nonEmptyCols) {
      out.push(`### ${col.name}`, "");
      for (const c of col.cards) {
        const bits: string[] = [c.priority];
        if (c.dueDate) bits.push(`due ${c.dueDate}`);
        if (c.assignee) bits.push(`@${c.assignee}`);
        if (c.tagNames.length > 0) bits.push(c.tagNames.map((t) => `#${t}`).join(" "));
        out.push(`- **${c.title}** _(${bits.join(", ")})_`);
        if (c.description) out.push(`  ${c.description.replace(/\n/g, "\n  ")}`);
      }
      out.push("");
    }
  }

  if (project.notes.length > 0) {
    out.push("## Notes", "");
    for (const n of project.notes) {
      const folderLabel = n.folder ? `${n.folder}/` : "";
      out.push(`### ${folderLabel}${n.title}`, "");
      const tags = tagLine(n.tagNames);
      if (tags) out.push(tags, "");
      out.push(stripDuplicateTitleH1(n.content, n.title).trimEnd(), "");
    }
  }

  return out.join("\n").trimEnd() + "\n";
}
