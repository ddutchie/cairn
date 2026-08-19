import type Database from "better-sqlite3";
import * as q from "../db/queries";
import { writeNoteFile } from "../notes-files";
import { callLLM, type LLMConfig } from "./llm";
import { newId } from "../db/utils";

export interface GeneratePrdArgs {
  projectId: string;
  title: string;
  requirements: string;
}

export async function generatePrd(
  db: Database.Database,
  workspacePath: string,
  args: GeneratePrdArgs,
  llmConfig: LLMConfig,
  insertNotification?: (tool: string, title: string, body: string) => void,
) {
  const snap = q.getFullSnapshot(db);
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };

  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const systemPrompt = `You are an expert product manager. Generate a thorough, well-structured Product Requirements Document (PRD) in markdown format. Include all standard sections. Be specific and actionable.\n\nToday's date is ${date}.`;
  const userPrompt = `Generate a complete PRD for the following:\n\n${args.requirements}\n\nInclude these sections:\n# ${args.title}\n\n## Overview\n## Problem Statement\n## Goals & Non-Goals\n## User Stories\n## Functional Requirements\n## Non-Functional Requirements\n## Acceptance Criteria\n## Open Questions\n\nReturn only the markdown document, no commentary.`;

  let prdMarkdown: string;
  try {
    const { runOneShot } = await import("../cordis/one-shot");
    prdMarkdown = await runOneShot({
      systemPrompt, userPrompt,
      config: llmConfig,
      source: "prd",
      projectId: args.projectId,
      workspaceId: project.workspaceId,
    });
  } catch (err) {
    return { error: `Failed to generate PRD: ${(err as Error).message}` };
  }

  const noteId = newId();
  const note = q.createNote(db, {
    id: noteId,
    projectId: args.projectId,
    workspaceId: project.workspaceId,
    title: args.title,
    content: prdMarkdown,
  });
  writeNoteFile(workspacePath, { ...note, projectName: project.name });

  insertNotification?.("generate_prd", "PRD created", `"${args.title}" added to ${project.name}`);

  return { id: note.id, title: note.title, projectId: note.projectId, content: prdMarkdown };
}
