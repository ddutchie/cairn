import { parseWikilinks } from "./wikilink-parser";
import type { Note, TaskCard, BoardColumn } from "@/types";

/**
 * Parses raw prompt text for wikilinks [[Title]] and backticked paths `path`.
 * Resolves notes and task cards from memory (Zustand store), and files
 * asynchronously via Electron PTY fs APIs.
 *
 * Appends all resolved entities to the end of the prompt under a structured
 * === Attached Context === section.
 */
export async function resolvePromptContext(
  prompt: string,
  notes: Note[],
  cards: TaskCard[],
  columns: BoardColumn[],
  cwd: string | null
): Promise<string> {
  const wikilinks = parseWikilinks(prompt);

  // Extract backticked paths
  const backtickRegex = /`([^`\n]+?)`/g;
  const backtickMatches: string[] = [];
  let match;
  while ((match = backtickRegex.exec(prompt)) !== null) {
    const term = match[1].trim();
    if (term) backtickMatches.push(term);
  }

  const uniqueWikilinks = Array.from(new Set(wikilinks.map((wl) => wl.title)));
  const uniqueBackticks = Array.from(new Set(backtickMatches));

  const attachedContext: string[] = [];

  // Resolve wikilinks
  for (const title of uniqueWikilinks) {
    // 1. Check notes
    const note = notes.find(
      (n) => n.title.toLowerCase() === title.toLowerCase() && !n.archivedAt
    );
    if (note) {
      attachedContext.push(`[[${note.title}]]:
---
ID: ${note.id}
Type: ${note.type}
Folder: ${note.folder || "(root)"}
Content:
${note.content || "(empty)"}`);
      continue;
    }

    // 2. Check cards
    const card = cards.find(
      (c) => c.title.toLowerCase() === title.toLowerCase() && !c.archivedAt
    );
    if (card) {
      const col = columns.find((col) => col.id === card.columnId);
      attachedContext.push(`[[${card.title}]]:
---
ID: ${card.id}
Status: ${col?.name || "Unknown"}
Priority: ${card.priority}
Assignee: ${card.assignee || "none"}
Due Date: ${card.dueDate || "none"}
Description:
${card.description || "(no description)"}`);
    }
  }

  // Resolve backticks (files)
  if (typeof window !== "undefined" && window.electron && cwd) {
    for (const fileMatch of uniqueBackticks) {
      // Basic heuristic: check if it looks like a file path (has extension or slash)
      const hasExtension = /\.[a-zA-Z0-9]{1,10}$/.test(fileMatch);
      const hasSlash = fileMatch.includes("/") || fileMatch.includes("\\");
      if (hasExtension || hasSlash) {
        try {
          // Normalize paths
          const cleanCwd = cwd.endsWith("/") || cwd.endsWith("\\") ? cwd.slice(0, -1) : cwd;
          const cleanPath = fileMatch.startsWith("/") || fileMatch.startsWith("\\") ? fileMatch.slice(1) : fileMatch;
          const absolutePath = `${cleanCwd}/${cleanPath}`;

          const content = await window.electron.agent.readFile(absolutePath);
          attachedContext.push(`\`${fileMatch}\`:
---
${content}`);
        } catch (err) {
          // Ignore if file read fails (e.g. not a file, outside directory, or error)
          console.warn(`[context-resolver] Failed to read mentioned file: ${fileMatch}`, err);
        }
      }
    }
  }

  if (attachedContext.length > 0) {
    return `${prompt}\n\n=== Attached Context ===\n${attachedContext.join("\n\n")}`;
  }

  return prompt;
}
