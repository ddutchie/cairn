import { WidgetType, EditorView } from "@codemirror/view";

/**
 * Inline task-list checkbox for the Live Preview editor.
 *
 * Replaces the lezer `TaskMarker` node of a `- [ ]` / `- [x]` / `- [X]` list
 * item (exactly 3 chars) with a real checkbox. Toggling dispatches a document
 * change that flips the marker in the source (`[ ]` ↔ `[x]`), which flows
 * through the editor's normal onChange → debounced updateNote path, so the note
 * file is updated just like a read-mode checkbox toggle.
 *
 * Unlike the block widgets (callout/code/table), this is a tiny fixed-size
 * inline replace, so it needs none of the ResizeObserver / estimatedHeight
 * machinery. `ignoreEvent` swallows pointer/click events so a click runs the
 * checkbox's own handler WITHOUT also dropping the cursor onto the line (which
 * would unfold the raw `[ ]` for editing).
 */
export class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly checked: boolean,
  ) {
    super();
  }

  eq(other: TaskCheckboxWidget): boolean {
    return other.from === this.from && other.to === this.to && other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-lp-taskbox";
    input.checked = this.checked;
    input.title = this.checked ? "Mark as not done" : "Mark as done";
    input.addEventListener("change", () => {
      // Flip the source marker: checked → "[ ]", unchecked → "[x]".
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? "[ ]" : "[x]" },
      });
    });
    return input;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown" || event.type === "pointerdown" || event.type === "click";
  }
}

/** Factory matching the other widget factories (keeps livePreview.ts React-free). */
export function makeTaskCheckboxWidget(from: number, to: number, checked: boolean): TaskCheckboxWidget {
  return new TaskCheckboxWidget(from, to, checked);
}
