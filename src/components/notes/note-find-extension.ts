import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import { findMatches, type FindMatch, type FindOptions } from "../../../shared/notes/search";

/**
 * In-note find for the CodeMirror editor: highlights every match and marks the
 * current one. State lives in a field so matches follow edits; the find bar
 * reads them back with `getFindState`.
 */
interface FindSpec { query: string; opts: FindOptions; current: number }
interface FindState extends FindSpec { matches: FindMatch[] }

const setFindEffect = StateEffect.define<FindSpec | null>();

function compute(doc: string, spec: FindSpec): FindState {
  const matches = findMatches(doc, spec.query, spec.opts);
  const current = matches.length === 0 ? 0 : Math.min(Math.max(spec.current, 0), matches.length - 1);
  return { ...spec, current, matches };
}

const findField = StateField.define<FindState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFindEffect)) return e.value ? compute(tr.state.doc.toString(), e.value) : null;
    }
    if (value && tr.docChanged) return compute(tr.state.doc.toString(), value);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (state): DecorationSet => {
    if (!state || state.matches.length === 0) return Decoration.none;
    const b = new RangeSetBuilder<Decoration>();
    state.matches.forEach((m, i) => {
      b.add(m.from, m.to, Decoration.mark({ class: i === state.current ? "cm-find-match cm-find-current" : "cm-find-match" }));
    });
    return b.finish();
  }),
});

const findTheme = EditorView.baseTheme({
  ".cm-find-match": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)", borderRadius: "2px" },
  ".cm-find-current": {
    backgroundColor: "color-mix(in srgb, var(--accent) 55%, transparent)",
    outline: "1px solid var(--accent)",
  },
});

export const noteFindExtension = [findField, findTheme];

/** Apply (or, with null, clear) the find query. Optionally scrolls the current match into view. */
export function setFind(view: EditorView, spec: FindSpec | null, scroll = true): { count: number; current: number } {
  view.dispatch({ effects: setFindEffect.of(spec) });
  const st = view.state.field(findField, false) ?? null;
  if (!st) return { count: 0, current: 0 };
  if (scroll && st.matches.length > 0) {
    view.dispatch({ effects: EditorView.scrollIntoView(st.matches[st.current].from, { y: "center" }) });
  }
  return { count: st.matches.length, current: st.current };
}

export function getFindState(view: EditorView): { count: number; current: number } {
  const st = view.state.field(findField, false);
  return { count: st?.matches.length ?? 0, current: st?.current ?? 0 };
}
