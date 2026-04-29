import type Database from "better-sqlite3";
import * as q from "../db/queries";
import { writeNoteFile, stripMarkdown } from "../notes-files";
import { callLLM, type LLMConfig } from "./llm";

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

  const systemPrompt = `You are an expert product manager. Generate a thorough, well-structured Product Requirements Document (PRD) in markdown format. Include all standard sections. Be specific and actionable.`;
  const userPrompt = `Generate a complete PRD for the following:\n\n${args.requirements}\n\nInclude these sections:\n# ${args.title}\n\n## Overview\n## Problem Statement\n## Goals & Non-Goals\n## User Stories\n## Functional Requirements\n## Non-Functional Requirements\n## Acceptance Criteria\n## Open Questions\n\nReturn only the markdown document, no commentary.`;

  let prdMarkdown: string;
  try {
    prdMarkdown = await callLLM(llmConfig, systemPrompt, userPrompt);
  } catch (err) {
    return { error: `Failed to generate PRD: ${(err as Error).message}` };
  }

  const noteId = Math.random().toString(36).slice(2, 14);
  const note = q.createNote(db, {
    id: noteId,
    projectId: args.projectId,
    workspaceId: project.workspaceId,
    title: args.title,
    content: prdMarkdown,
    contentText: stripMarkdown(prdMarkdown),
  });
  writeNoteFile(workspacePath, { ...note, projectName: project.name });

  insertNotification?.("generate_prd", "PRD created", `"${args.title}" added to ${project.name}`);

  return { id: note.id, title: note.title, projectId: note.projectId, content: prdMarkdown };
}
