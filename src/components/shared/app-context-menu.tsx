"use client";

/**
 * AppContextMenu — the app-wide fallback right-click menu (cut / copy / paste /
 * select all, copy link). Electron shows no native menu, so without this a
 * right-click in a text field does nothing.
 *
 * It listens for `contextmenu` at the document and only acts when nothing else
 * claimed the event: Radix ContextMenu triggers (cards, notes…) call
 * preventDefault first, and any subtree can opt out with
 * `data-native-contextmenu`. xterm terminals are handled via the terminal
 * registry because they own their (canvas-painted) selection.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { BookPlus, ClipboardPaste, Copy, Eraser, Link2, MousePointerSquareDashed, Scissors } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { findTerminalFor } from "@/lib/terminal-registry";

interface SpellInfo {
  word: string;
  suggestions: string[];
}

type TextControl = HTMLInputElement | HTMLTextAreaElement;

interface MenuState {
  id: number;
  x: number;
  y: number;
  /** Focusable editing host, if the click landed in one. */
  host: HTMLElement | null;
  readOnly: boolean;
  selectedText: string;
  href: string | null;
  /** Saved selection so it survives the menu stealing focus. */
  inputRange: { start: number; end: number } | null;
  domRange: Range | null;
  /** Set when the click landed in an xterm terminal. */
  term: Terminal | null;
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number", ""]);

function isTextControl(el: Element | null): el is TextControl {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type);
}

const isMac = () => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

function restoreSelection(state: MenuState) {
  const host = state.host;
  if (!host) return;
  host.focus({ preventScroll: true });
  if (isTextControl(host) && state.inputRange) {
    host.setSelectionRange(state.inputRange.start, state.inputRange.end);
  } else if (state.domRange) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(state.domRange);
  }
}

export function AppContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [open, setOpen] = useState(false);
  const [spell, setSpell] = useState<SpellInfo | null>(null);
  const counter = useRef(0);
  // Electron's `context-menu` (misspelling) event races the DOM one; keep the
  // latest so whichever arrives second still pairs up.
  const lastSpell = useRef<{ info: SpellInfo; at: number } | null>(null);
  const lastOpenAt = useRef(0);

  useEffect(() => {
    return window.electron?.onSpellcheckContext((e) => {
      const info = { word: e.word, suggestions: e.suggestions };
      lastSpell.current = { info, at: Date.now() };
      if (Date.now() - lastOpenAt.current < 500) setSpell(info);
    });
  }, []);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || target.closest("[data-native-contextmenu]")) return;

      if (target.closest(".xterm")) {
        const term = findTerminalFor(target);
        if (!term) return;
        e.preventDefault();
        lastOpenAt.current = Date.now();
        setSpell(null);
        counter.current += 1;
        setMenu({
          id: counter.current, x: e.clientX, y: e.clientY, host: null, readOnly: true,
          selectedText: term.getSelection(), href: null, inputRange: null, domRange: null, term,
        });
        setOpen(true);
        return;
      }

      const control = target.closest("input, textarea");
      const textControl = isTextControl(control) ? control : null;
      const editable = target.closest<HTMLElement>('[contenteditable]:not([contenteditable="false"])');
      const link = target.closest<HTMLAnchorElement>("a[href]");

      let host: HTMLElement | null = null;
      let readOnly = true;
      let selectedText = "";
      let inputRange: MenuState["inputRange"] = null;
      let domRange: Range | null = null;

      if (textControl) {
        host = textControl;
        readOnly = textControl.readOnly || textControl.disabled;
        const start = textControl.selectionStart ?? 0;
        const end = textControl.selectionEnd ?? 0;
        inputRange = { start, end };
        // Password fields never expose their text to the clipboard.
        selectedText = textControl.type === "password" ? "" : textControl.value.slice(start, end);
      } else {
        const sel = window.getSelection();
        selectedText = sel?.toString() ?? "";
        if (editable) {
          host = editable;
          readOnly = false;
          if (sel && sel.rangeCount > 0) domRange = sel.getRangeAt(0).cloneRange();
        }
      }

      const href = link?.href ?? null;
      if (!host && !selectedText && !href) return;

      // Deliberately NOT preventDefault: Chromium only forwards the misspelling
      // to Electron's `context-menu` event if the page leaves the event alone,
      // and Electron shows no native menu of its own.
      lastOpenAt.current = Date.now();
      const recent = lastSpell.current && Date.now() - lastSpell.current.at < 500 ? lastSpell.current.info : null;
      setSpell(host && !readOnly ? recent : null);
      counter.current += 1;
      setMenu({ id: counter.current, x: e.clientX, y: e.clientY, host, readOnly, selectedText, href, inputRange, domRange, term: null });
      setOpen(true);
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const copy = useCallback(async (m: MenuState) => {
    if (m.selectedText) await navigator.clipboard.writeText(m.selectedText);
  }, []);

  const cut = useCallback(async (m: MenuState) => {
    if (!m.selectedText) return;
    await navigator.clipboard.writeText(m.selectedText);
    restoreSelection(m);
    document.execCommand("delete");
  }, []);

  const paste = useCallback(async (m: MenuState) => {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    restoreSelection(m);
    // execCommand keeps native undo and fires the input events React/CodeMirror expect.
    if (!document.execCommand("insertText", false, text) && isTextControl(m.host)) {
      m.host.setRangeText(text, m.host.selectionStart ?? 0, m.host.selectionEnd ?? 0, "end");
      m.host.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, []);

  const replaceWord = useCallback((m: MenuState, word: string) => {
    m.host?.focus({ preventScroll: true });
    void window.electron?.spellcheckReplace(word);
  }, []);

  const pasteTerminal = useCallback(async (term: Terminal) => {
    const text = await navigator.clipboard.readText();
    if (text) term.paste(text);
    term.focus();
  }, []);

  const selectAll = useCallback((m: MenuState) => {
    if (m.term) {
      m.term.selectAll();
    } else if (m.host) {
      m.host.focus({ preventScroll: true });
      if (isTextControl(m.host)) m.host.select();
      else document.execCommand("selectAll");
    } else {
      document.execCommand("selectAll");
    }
  }, []);

  if (!menu) return null;
  const mod = isMac() ? "⌘" : "Ctrl+";
  const hasSelection = menu.selectedText.length > 0;
  const editable = menu.host !== null && !menu.readOnly;
  const kbd = (k: string) => (
    <span className="ml-auto pl-4 text-[0.643rem] font-mono text-[var(--text-tertiary)]">{mod}{k}</span>
  );

  return (
    <DropdownMenu key={menu.id} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{ position: "fixed", left: menu.x, top: menu.y, width: 0, height: 0, pointerEvents: "none" }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={0}
        className="min-w-[170px]"
        // Keep focus in the field we're about to edit instead of returning it to the anchor.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {editable && spell && (
          <>
            {spell.suggestions.length > 0 ? (
              spell.suggestions.map((word) => (
                <DropdownMenuItem key={word} onSelect={() => replaceWord(menu, word)} className="font-medium text-[var(--text-primary)]">
                  {word}
                </DropdownMenuItem>
              ))
            ) : (
              <div className="px-3 py-1.5 text-xs text-[var(--text-tertiary)]">No suggestions</div>
            )}
            <DropdownMenuItem onSelect={() => void window.electron?.spellcheckAddWord(spell.word)}>
              <BookPlus size={13} /> Add &ldquo;{spell.word}&rdquo; to dictionary
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {menu.href && (
          <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(menu.href!)}>
            <Link2 size={13} /> Copy link address
          </DropdownMenuItem>
        )}
        {menu.href && (editable || hasSelection) && <DropdownMenuSeparator />}
        {editable && hasSelection && (
          <DropdownMenuItem onSelect={() => void cut(menu)}>
            <Scissors size={13} /> Cut {kbd("X")}
          </DropdownMenuItem>
        )}
        {hasSelection && (
          <DropdownMenuItem onSelect={() => void copy(menu)}>
            <Copy size={13} /> Copy {kbd("C")}
          </DropdownMenuItem>
        )}
        {editable && (
          <DropdownMenuItem onSelect={() => void paste(menu)}>
            <ClipboardPaste size={13} /> Paste {kbd("V")}
          </DropdownMenuItem>
        )}
        {menu.term && !menu.term.options.disableStdin && (
          <DropdownMenuItem onSelect={() => void pasteTerminal(menu.term!)}>
            <ClipboardPaste size={13} /> Paste {kbd("V")}
          </DropdownMenuItem>
        )}
        {(editable || hasSelection || menu.term) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => selectAll(menu)}>
              <MousePointerSquareDashed size={13} /> Select all {kbd("A")}
            </DropdownMenuItem>
          </>
        )}
        {menu.term && (
          <DropdownMenuItem onSelect={() => { menu.term!.clear(); menu.term!.focus(); }}>
            <Eraser size={13} /> Clear terminal
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
