/**
 * The MCP server's `instructions`, sent once in the initialize result. Clients
 * such as Claude Code put them in the agent's system prompt, so how to work
 * with Cairn travels with the server instead of being copied into every
 * repository's AGENTS.md / CLAUDE.md.
 *
 * Kept short (it is in every request the client makes) and only about how to
 * use the tools together; what each tool does stays in its own description.
 * The in-app coding agent gets a fuller version of the same workflow from
 * `electron/lib/coding-session-prompt.ts`.
 */
export const MCP_SERVER_INSTRUCTIONS = `Cairn is the user's project workspace: notes, a task board, idea flows and people. Use it to track the work you do.

- Start with get_context for workspace, project and column ids, and the user's conventions.
- Project links: get_context(projectId) lists where the project's material lives (Confluence space, Slack channels, Jira project, repo) with a \`ref\` each connector tool can take. Use them before searching a connector, and when you learn of a new place worth keeping, add it with upsert_project addLinks.
- Before you start on a task, find its card (search_tasks) or create one (create_task), then task_progress "claim" it. Log notable steps with task_progress "log", and when finished move it to review (changes made) or done (resolved and verified).
- Something worth fixing outside the current task: create_task for it, with a priority. Search first so you don't duplicate a card.
- Findings, decisions and bugs go in a note as you find them: ensure_note with a stable, specific title ("Decision: …", "Bug: …") so a rerun updates the same note. End a session with an "Agent session: <task>" note: what changed, what you found, what's left.
- Working from a plan note with a "- [ ]" checklist: tick each item with edit_note as you finish it.
- Prose written for the user: match get_user_writing_style.`;
