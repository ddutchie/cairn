import { personMentionContext } from "@cairn/shared/people/mentions";
import { agentHiddenNoteIds } from "@cairn/shared/people/queries";
import { peopleDb, peopleWorkspaceId } from "@/db/people";
import { isPeopleEnabled } from "@/people/flag";

/** Model-only block about the people a message `@`-mentions; undefined when none or People is off. */
export function mentionContext(text: string): string | undefined {
  if (!isPeopleEnabled() || !text.includes("@")) return undefined;
  try {
    const ws = peopleWorkspaceId();
    if (!ws) return undefined;
    const db = peopleDb();
    return personMentionContext(db, { enabled: true }, ws, text, agentHiddenNoteIds(db));
  } catch (err) {
    console.warn("[people] couldn't attach mentioned people:", err);
    return undefined;
  }
}
