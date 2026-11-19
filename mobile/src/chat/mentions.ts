import { personMentionContext } from "@cairn/shared/people/mentions";
import { agentHiddenNoteIds } from "@cairn/shared/people/queries";
import { peopleDb, peopleWorkspaceId } from "@/db/people";

/** Model-only block about the people a message `@`-mentions; undefined when none or People is off. */
export function mentionContext(text: string, chosen?: ReadonlyMap<string, string>): string | undefined {
  if (!text.includes("@")) return undefined;
  try {
    const ws = peopleWorkspaceId();
    if (!ws) return undefined;
    const db = peopleDb();
    return personMentionContext(db, {}, ws, text, agentHiddenNoteIds(db), chosen);
  } catch (err) {
    console.warn("[people] couldn't attach mentioned people:", err);
    return undefined;
  }
}
