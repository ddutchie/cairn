import { confirmsByDefault } from "@cairn/shared/agent/tool-risk";
import type { ConfirmRequest } from "./confirm-store";

/**
 * Which calls wait on the Confirm / Cancel card, and what the card says. The rule
 * is shared with desktop (`confirmsByDefault`); this only words it. Lookups are
 * injected so it stays testable without sqlite.
 */
export interface ConfirmLookup {
  noteTitle: (id: string) => string | undefined;
  taskTitle: (id: string) => string | undefined;
  personName: (id: string) => string | undefined;
}

/** What a cancelled call returns to the model. */
export const CANCELLED_RESULT = {
  cancelled: true,
  note: "The user said no on the confirmation card. Nothing changed. Don't retry this or ask again unless they bring it up.",
} as const;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The card for this call, or undefined to run it straight away. A delete whose
 * target is missing runs without a card, so the tool reports it as not found.
 */
export function confirmRequestFor(name: string, args: Record<string, unknown>, lookup: ConfirmLookup): ConfirmRequest | undefined {
  if (!confirmsByDefault(name, args)) return undefined;
  if (name === "delete") {
    const id = str(args.id);
    const kind = args.type === "task" ? "task" : args.type === "note" ? "note" : undefined;
    if (!kind) return undefined;
    const title = kind === "note" ? lookup.noteTitle(id) : lookup.taskTitle(id);
    if (title === undefined) return undefined;
    return {
      title: `Delete the ${kind} “${title.trim() || "Untitled"}”?`,
      detail: "It goes on every device that syncs with this one.",
      confirmLabel: `Delete ${kind}`,
    };
  }
  const person = (idKey: string) => {
    const id = str(args[idKey]);
    return (id && lookup.personName(id)) || (idKey === "personId" && str(args.name)) || "this person";
  };
  switch (args.action) {
    case "archive":
      return {
        title: `Archive ${person("personId")}?`,
        detail: "They leave the People lists on every synced device. Their notes and meetings stay, and you can restore them.",
        confirmLabel: "Archive",
      };
    case "merge": {
      const kept = person("personId");
      return {
        title: `Merge ${person("otherPersonId")} into ${kept}?`,
        detail: `Their notes, meetings and links move to ${kept}, and the duplicate is removed.`,
        confirmLabel: "Merge",
      };
    }
    case "team_delete":
      return {
        title: `Delete the team “${str(args.team) || "this team"}”?`,
        detail: "The people on it stay in People.",
        confirmLabel: "Delete team",
      };
    default:
      return { title: "Allow this change?", confirmLabel: "Allow" };
  }
}
