import type { SuggestedAction } from "@/types";

/** Store-backed title resolution for suggested-connection labels. */
export interface ActionTitleLookups {
  noteTitle: (id: string | undefined) => string | undefined;
  cardTitle: (id: string | undefined) => string | undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Fill in a missing/invalid action `type` from the fields the model did send.
 * Small models often omit `type` (everything around it is optional and the
 * call still executes), which previously rendered a blank card with just an
 * Apply button. Shapes observed in the wild:
 *   cardId + targetNoteId/noteId          → link_note_card
 *   sourceNoteId + targetNoteId            → link_note_note
 *   sourceNoteId + targetTitle (no IDs)    → add_wikilink
 *   tagName                                → add_tag
 *
 * Canonicalizes alias fields too, so apply can rely on one shape: the note
 * side of a card link may arrive as noteId, sourceNoteId, nodeId
 * (nodeType "note"), or targetNoteId; same for titles.
 */
export function normalizeSuggestedAction(action: SuggestedAction): SuggestedAction {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = { ...(action as any) };
  const has = (v: unknown) => str(v) !== undefined;
  const valid = ["add_wikilink", "link_note_note", "link_note_card", "add_tag"].includes(a.type);

  if (!valid) {
    const cardSide =
      has(a.cardId) || (a.nodeType === "card" && has(a.nodeId));
    const noteSide =
      has(a.noteId) || has(a.sourceNoteId) || has(a.targetNoteId) ||
      (a.nodeType === "note" && has(a.nodeId)) ||
      (has(a.nodeId) && a.nodeType !== "card" && cardSide);
    if (has(a.tagName)) a.type = "add_tag";
    else if (cardSide && noteSide) a.type = "link_note_card";
    else if (has(a.targetNoteId)) a.type = "link_note_note";
    else if (has(a.sourceNoteId)) a.type = "add_wikilink";
  }

  if (a.type === "link_note_card") {
    // Note side — prefer an explicit note-side id. targetNoteId doubles as
    // the note side when nothing else identifies it (the observed typeless
    // shape); a bare nodeId alongside cardId is likewise the note side.
    // The title follows whichever id was selected so label and Apply agree.
    const srcNoteId = str(a.noteId) ?? str(a.sourceNoteId) ?? (a.nodeType === "note" ? str(a.nodeId) : undefined);
    const tgtNoteId = str(a.targetNoteId);
    const noteId = srcNoteId ?? tgtNoteId ?? str(a.nodeId);
    a.noteId = noteId;
    if (!has(a.noteTitle)) {
      a.noteTitle =
        noteId !== undefined && noteId === tgtNoteId ? str(a.targetTitle) :
        noteId !== undefined && noteId === str(a.nodeId) && a.nodeType !== "card" ? str(a.nodeTitle) :
        str(a.sourceTitle);
    }
    // Card side — targetNoteId is never a card here: when it identified the
    // note side it is already consumed above, otherwise it is unrelated.
    const cardId = str(a.cardId) ?? (a.nodeType === "card" ? str(a.nodeId) : undefined);
    a.cardId = cardId;
    if (!has(a.cardTitle)) {
      a.cardTitle =
        cardId !== undefined && cardId === tgtNoteId ? str(a.targetTitle) :
        cardId !== undefined && cardId === str(a.nodeId) ? str(a.nodeTitle) :
        str(a.cardTitle);
    }
  } else if (a.type === "link_note_note") {
    a.sourceNoteId ??= a.noteId ?? a.nodeId;
    a.sourceTitle ??= a.noteTitle ?? a.nodeTitle;
    // A bare nodeId is the second note when it isn't already the source.
    a.targetNoteId ??= a.nodeId !== a.sourceNoteId ? a.nodeId : undefined;
  } else if (a.type === "add_wikilink") {
    a.sourceNoteId ??= a.noteId ?? (a.nodeType !== "card" ? a.nodeId : undefined);
    a.targetTitle ??= a.cardTitle ?? a.noteTitle ?? a.nodeTitle;
  } else if (a.type === "add_tag") {
    a.nodeId ??= a.noteId ?? a.cardId ?? a.sourceNoteId;
    // applyAction tags the note branch unless nodeType is exactly "card",
    // so only infer nodeType from an unambiguous signal — otherwise leave it
    // unset and let apply reject instead of reporting a false success.
    if (!has(a.nodeType)) {
      const looksNote = has(a.noteId) || has(a.sourceNoteId);
      const looksCard = has(a.cardId);
      if (looksNote && !looksCard) a.nodeType = "note";
      else if (looksCard && !looksNote) a.nodeType = "card";
    }
  }
  return a as SuggestedAction;
}

/**
 * Human label for a suggested-connection card.
 *
 * Never returns an empty string: model-sent titles win, then store lookups by
 * ID (the schema + prompt emphasize IDs, so small models often omit titles),
 * then the raw ID, then "untitled". Unknown action `type` values get a generic
 * label instead of rendering a blank card with just an Apply button.
 */
export function describeSuggestedAction(
  action: SuggestedAction,
  lookups?: ActionTitleLookups,
): string {
  // The payload comes from the model — fields may be missing or misnamed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = action as any;
  const noteLabel = (id: string | undefined, ...titleKeys: string[]): string => {
    for (const k of titleKeys) {
      const t = str(a[k]);
      if (t) return t;
    }
    if (id) return lookups?.noteTitle(id) ?? id;
    return "untitled";
  };
  const cardLabel = (id: string | undefined, ...titleKeys: string[]): string => {
    for (const k of titleKeys) {
      const t = str(a[k]);
      if (t) return t;
    }
    if (id) return lookups?.cardTitle(id) ?? id;
    return "untitled";
  };

  switch (action.type) {
    case "add_wikilink": {
      const target = str(a.targetTitle) ?? str(a.cardTitle) ?? str(a.noteTitle) ?? "untitled";
      const source = noteLabel(str(a.sourceNoteId) ?? str(a.noteId) ?? str(a.nodeId), "sourceTitle", "noteTitle", "nodeTitle");
      return `Add [[${target}]] → "${source}"`;
    }
    case "link_note_note": {
      const source = noteLabel(str(a.sourceNoteId) ?? str(a.noteId) ?? str(a.nodeId), "sourceTitle", "noteTitle", "nodeTitle");
      const target = noteLabel(str(a.targetNoteId) ?? str(a.cardId) ?? str(a.nodeId), "targetTitle", "cardTitle", "noteTitle");
      return `Link "${source}" ↔ "${target}"`;
    }
    case "link_note_card": {
      const note = noteLabel(str(a.noteId) ?? str(a.sourceNoteId) ?? str(a.nodeId), "noteTitle", "sourceTitle", "nodeTitle");
      const card = cardLabel(str(a.cardId) ?? str(a.targetNoteId), "cardTitle", "targetTitle");
      return `Link "${note}" → "${card}"`;
    }
    case "add_tag": {
      const node =
        a.nodeType === "card"
          ? cardLabel(str(a.nodeId) ?? str(a.cardId), "nodeTitle", "cardTitle")
          : noteLabel(str(a.nodeId) ?? str(a.noteId) ?? str(a.sourceNoteId), "nodeTitle", "noteTitle", "sourceTitle");
      const tag = str(a.tagName) ?? "untitled";
      return `Tag "${node}" #${tag}`;
    }
    default:
      return `Suggested action (${String((action as { type?: unknown }).type ?? "unknown")})`;
  }
}
