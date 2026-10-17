/**
 * Split markdown into independently-renderable chunks so a streaming message
 * re-parses only its trailing chunk per token instead of the whole growing
 * document (quadratic over a long reply).
 *
 * Boundaries are deliberately conservative — a blank line followed by an ATX
 * heading outside a fenced code block. A heading at column 0 always terminates
 * lists, quotes and paragraphs, so rendering the chunks separately yields the
 * same output as rendering the whole. Anything whose meaning can cross such a
 * boundary (link reference definitions, footnotes, HTML comments, raw HTML blocks) disables
 * splitting.
 */

/** Below this size a single parse is cheap; don't bother splitting. */
export const MIN_SPLIT_LENGTH = 1500;

const CROSS_BOUNDARY = /^ {0,3}\[[^\]\n]+\]:\s*\S|\[\^[^\]\n]+\]|<!--|<\/?(?:details|summary|div|table|pre|section|blockquote)\b/im;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function splitMarkdownBlocks(content: string): string[] {
  if (content.length < MIN_SPLIT_LENGTH || CROSS_BOUNDARY.test(content)) return [content];

  const lines = content.split("\n");
  const chunks: string[] = [];
  let start = 0;
  let fence: { char: string; len: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      const char = f[1][0];
      if (!fence) fence = { char, len: f[1].length };
      else if (char === fence.char && f[1].length >= fence.len && line.trim() === f[1]) fence = null;
      continue;
    }
    if (fence) continue;
    if (i > start && HEADING.test(line) && lines[i - 1].trim() === "") {
      chunks.push(lines.slice(start, i).join("\n"));
      start = i;
    }
  }
  chunks.push(lines.slice(start).join("\n"));
  return chunks;
}
