/**
 * Shared writing-style helpers — section-aware append for the canonical 12-section guide.
 * Single source of truth for desktop (`electron/db/user-style-queries.ts`) and mobile
 * (`mobile/src/db/queries.ts`). Keep section matching, deduplication, and insertion behavior identical.
 */
export function appendToStyleGuide(
  existingGuide: string,
  section: string | undefined,
  content: string,
): string {
  const trimmedContent = content.trim();
  if (!trimmedContent) return existingGuide;
  if (existingGuide && existingGuide.includes(trimmedContent)) return existingGuide;

  const bulletContent = /^[-*•]\s/.test(trimmedContent) ? trimmedContent : `- ${trimmedContent}`;

  if (!existingGuide || existingGuide.trim() === "") {
    if (section?.trim()) {
      return `## ${section.trim()}\n${bulletContent}\n`;
    }
    return `${bulletContent}\n`;
  }

  if (!section || section.trim() === "") {
    return `${existingGuide.trimEnd()}\n\n${bulletContent}\n`;
  }

  const sectionNorm = section.trim().toLowerCase();
  const numMatch = sectionNorm.match(/^(\d+)\b/);
  const targetNum = numMatch ? parseInt(numMatch[1], 10) : null;

  const lines = existingGuide.split("\n");
  const headingIndices: number[] = [];
  const headingTexts: string[] = [];
  lines.forEach((line, idx) => {
    if (/^##\s+/.test(line)) {
      headingIndices.push(idx);
      headingTexts.push(line.replace(/^##\s+/, "").trim());
    }
  });

  let targetIdx = -1;
  if (targetNum !== null) {
    targetIdx = headingIndices.findIndex((_, hi) => {
      const txt = headingTexts[hi].toLowerCase();
      return txt.startsWith(`${targetNum}.`) || txt.startsWith(`${targetNum} `);
    });
  }
  if (targetIdx === -1) {
    const lowerSection = sectionNorm.replace(/^\d+\.?\s*/, "").trim();
    if (lowerSection) {
      targetIdx = headingTexts.findIndex(
        (t) => t.toLowerCase().includes(lowerSection) || lowerSection.includes(t.toLowerCase()),
      );
    }
  }

  if (targetIdx === -1) {
    return `${existingGuide.trimEnd()}\n\n## ${section.trim()}\n${bulletContent}\n`;
  }

  const nextHeadingLineIdx =
    targetIdx + 1 < headingIndices.length ? headingIndices[targetIdx + 1] : lines.length;
  const before = lines.slice(0, nextHeadingLineIdx);
  const after = lines.slice(nextHeadingLineIdx);
  const beforeStr = before.join("\n").trimEnd();
  const afterStr = after.join("\n");
  const newGuide = beforeStr + "\n\n" + bulletContent + (afterStr ? "\n\n" + afterStr.replace(/^\n+/, "") : "\n");
  return newGuide;
}
