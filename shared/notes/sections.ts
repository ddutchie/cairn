/**
 * Split a note into embedding-friendly sections, delimited by top-level (`#`)
 * and second-level (`##`) markdown headings. Shared by desktop (`bge-small`
 * pipeline) and mobile (Apple on-device embeddings) so both index notes with
 * IDENTICAL section boundaries — the embedding vectors differ per platform, but
 * the chunking must not, or reindex/search behaviour would drift between them.
 *
 * Pure, dependency-free.
 */

export interface NoteSection {
  idx: number;
  title: string;
  text: string;
}

const HEADER_RE = /^(#{1,6})\s+(.+)$/;

export function splitIntoSections(noteTitle: string, content: string): NoteSection[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const lines = trimmed.split("\n");
  const sections: NoteSection[] = [];
  let currentTitle = noteTitle || "Untitled";
  let currentLines: string[] = [];
  let idx = 0;

  function flush() {
    const text = currentLines.join("\n").trim();
    if (text) {
      sections.push({ idx, title: currentTitle, text });
      idx++;
    }
  }

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
