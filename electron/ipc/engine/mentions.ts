/** `@Name` in a message: what Cairn knows about the people it names, as model-only context for that turn. */
import type { DbContext } from "../result-helpers";
import { agentHiddenNoteIds, isPeopleEnabled } from "../../db/people-queries";
import { personMentionContext } from "../../../shared/people/mentions";

/** The block for the people `text` mentions; nothing when People is off or nobody is named. Never throws. */
export function mentionContext(ctx: DbContext, workspaceId: string | undefined, text: string): string | undefined {
  try {
    const enabled = isPeopleEnabled(ctx.db);
    if (!enabled || !workspaceId) return undefined;
    return personMentionContext(ctx.db, { enabled }, workspaceId, text, agentHiddenNoteIds(ctx.db));
  } catch (err) {
    console.warn("[people] couldn't attach mentioned people:", err);
    return undefined;
  }
}
