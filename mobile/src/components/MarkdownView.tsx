import { lazy, Suspense, useCallback, useMemo, type ReactNode } from "react";
import { Linking, Text, View, Pressable, type StyleProp, type TextStyle } from "react-native";
import Markdown, { MarkdownIt, type RenderRules, type ASTNode } from "react-native-markdown-display";
import markdownItMark from "markdown-it-mark";
import { useRouter } from "expo-router";
import {
  Square,
  CheckSquare,
  Info,
  Lightbulb,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  Quote,
  type LucideIcon,
} from "lucide-react-native";
import { useTheme, withAlpha, surfaceTint, type Theme } from "@/theme";
import { findNoteIdByTitle, findCardIdByTitle, liveNoteTitleById, liveCardTitleById } from "@/db/queries";
import { CodeBlock } from "@/components/CodeBlock";
import {
  preprocessCairnMarkdown,
  noteTitleFromUrl,
  cardIdFromUrl,
  isColorLiteral,
  toggleCheckboxInSource,
  CELL_CHECKBOX_RE,
  type WikilinkResolver,
} from "@cairn/shared/notes/markdown";
import { headingSlug } from "@cairn/shared/notes/toc";

// Mermaid + KaTeX bundle their renderer sources as ~1 MB inline strings
// (mermaid-assets.ts alone is 3.5k lines). A static import would evaluate those
// modules — and heap-allocate the strings — at bundle init, i.e. every time ANY
// note opens, even a plain-text one. Loading them lazily defers that cost until
// a note actually contains a diagram / math block.
const MermaidView = lazy(() =>
  import("@/components/MermaidView").then((m) => ({ default: m.MermaidView })),
);
const MathView = lazy(() =>
  import("@/components/MathView").then((m) => ({ default: m.MathView })),
);

/**
 * Themed markdown renderer with Cairn desktop parity.
 *
 * Features mirrored from the desktop remark pipeline / .prose-cairn styling:
 *   - GFM: headings, lists, tables, blockquotes, strikethrough.
 *   - Syntax-highlighted fenced code (CodeBlock) with a language header + copy.
 *   - [[Wikilinks]] → tappable, navigate to the linked note.
 *   - ![[embeds]] → italic placeholder (binary assets out of the mobile MVP).
 *   - > [!type] callouts → coloured callout blocks.
 *   - ==highlight== → <mark> (via markdown-it-mark).
 *   - Interactive task-list checkboxes — tapping toggles the source and calls
 *     onChangeContent (when provided).
 *   - Inline code colour swatches for CSS colour literals.
 *
 * Cairn syntax is rewritten to standard markdown (shared preprocessCairnMarkdown)
 * so markdown-it can parse it; wikilinks become cairn://note/ or cairn://task/
 * links intercepted by onLinkPress. With resolveLinks on, ids are baked in at
 * preprocess time (desktop parity); otherwise notes resolve by title on tap.
 */
export function MarkdownView({
  content,
  onChangeContent,
  onHeadingLayout,
  resolveLinks = false,
}: {
  content: string;
  /** When provided, task-list checkboxes become interactive. */
  onChangeContent?: (next: string) => void;
  /** Reports each rendered heading's y-offset (relative to this component's
   *  container) keyed by GitHub-style slug — used to drive scroll-to-heading
   *  from the Table of Contents. */
  onHeadingLayout?: (id: string, y: number) => void;
  /** When true, `[[wikilinks]]` are resolved to concrete note/card ids at
   *  preprocess time (baked into the URL) — matching desktop, so taps navigate
   *  deterministically without tap-time title matching or collision misrouting.
   *  Cards become linkable too. Off by default (plain note bodies keep the
   *  cheap title-encoded form, resolved on tap). Turn on for chat. */
  resolveLinks?: boolean;
}) {
  const t = useTheme();
  const router = useRouter();
  const styles = useMemo(() => markdownStyles(t), [t]);

  // Resolve a wikilink target: the inner text of [[X]] may be an exact note/card
  // ID (preferred — the assistant emits [[id]] which we render as the title, so
  // duplicate titles never misroute) OR a human title (fallback, deterministic).
  // Only used when resolveLinks is on (chat).
  const resolve = useMemo<WikilinkResolver | undefined>(() => {
    if (!resolveLinks) return undefined;
    return (ref: string) => {
      // 1. Exact id match (note, then card) → render the canonical title.
      const noteTitle = liveNoteTitleById(ref);
      if (noteTitle) return { kind: "note", id: ref, title: noteTitle };
      const cardTitle = liveCardTitleById(ref);
      if (cardTitle) return { kind: "card", id: ref, title: cardTitle };
      // 2. Title match (notes win a tie, as the AI most often links notes).
      const noteId = findNoteIdByTitle(ref);
      if (noteId) return { kind: "note", id: noteId };
      const cardId = findCardIdByTitle(ref);
      if (cardId) return { kind: "card", id: cardId };
      return null;
    };
  }, [resolveLinks]);

  const src = useMemo(() => preprocessCairnMarkdown(content ?? "", resolve), [content, resolve]);

  const onLinkPress = useCallback((url: string): boolean => {
    // Card/task links carry an id directly (baked in at preprocess).
    const cardId = cardIdFromUrl(url);
    if (cardId != null) {
      // Only navigate if the card actually exists — a baked id always does, but
      // a title-encoded fallback might not resolve. Never route to an empty screen.
      const id = liveCardTitleById(cardId) != null ? cardId : findCardIdByTitle(cardId);
      if (id) router.push(`/card/${id}`);
      return false; // handled — swallow the tap even when unresolved
    }
    // Note links carry either a baked id (resolveLinks) or a title (fallback).
    const noteRef = noteTitleFromUrl(url);
    if (noteRef != null) {
      // Resolve to a real note: by title first (note-body fallback), else treat
      // the value as a baked id only if it names a live note. An unresolved
      // wikilink must NOT navigate (desktop parity — it's a dead link that just
      // renders dimmed), so we swallow the tap instead of pushing to an empty
      // /note/<garbage> screen.
      const id = findNoteIdByTitle(noteRef) ?? (liveNoteTitleById(noteRef) ? noteRef : null);
      if (id) router.push(`/note/${id}`);
      return false; // handled (resolved or not) — don't open externally
    }
    Linking.openURL(url).catch(() => {});
    return false;
  }, [router]);
  const rules = useMemo(
    () => makeRules(t, content ?? "", onChangeContent, onHeadingLayout, onLinkPress),
    [t, content, onChangeContent, onHeadingLayout, onLinkPress],
  );

  return (
    <Markdown
      markdownit={markdownItInstance}
      style={styles}
      rules={rules}
      onLinkPress={onLinkPress}
    >
      {src}
    </Markdown>
  );
}

// A single markdown-it instance: GFM-ish (breaks + linkify + typographer) plus
// ==highlight== support and task-list detection. Tables/strikethrough are on by
// default in markdown-it.
const markdownItInstance = MarkdownIt({ breaks: true, linkify: true, typographer: true })
  .use(markdownItMark)
  .use(taskListPlugin as unknown as Parameters<ReturnType<typeof MarkdownIt>["use"]>[0])
  .use(calloutPlugin as unknown as Parameters<ReturnType<typeof MarkdownIt>["use"]>[0])
  .use(mathPlugin as unknown as Parameters<ReturnType<typeof MarkdownIt>["use"]>[0]);

/**
 * markdown-it plugin: detect GFM task-list items. For each list item whose first
 * inline text starts with `[ ]`/`[x]`, strip that marker from the text token and
 * stash `{ isTask, checked, taskIndex }` on the `list_item_open` token's meta.
 * Stripping here (not in the render rule) is what stops the literal `[x]` from
 * rendering twice — the marker is gone from the children by render time.
 *
 * Table cells are also scanned: GFM crams a whole checklist into one cell
 * (`- [ ] a<br>- [x] b`), which markdown-it keeps as a single text token. We
 * stash `{ cellTasks: [{ checked, taskIndex }] }` on the cell's inline token so
 * the td/th render rule can draw checkboxes. Both list items and cell checkboxes
 * share ONE document-order `taskIndex` counter so it lines up with
 * toggleCheckboxInSource (which counts list-lines and table-cell tokens in the
 * same order).
 */
function taskListPlugin(md: MdItLike) {
  md.core.ruler.after("inline", "cairn_task_lists", (state) => {
    const tokens = state.tokens as MdToken[];
    let taskIndex = 0;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];

      if (tok.type === "td_open" || tok.type === "th_open") {
        // A table cell's inline content is the next token (html is off, so
        // `<br>` stays literal in one text token). Enumerate every checkbox
        // token in document order, record its global taskIndex, and stash the
        // segments (text/checkbox parts) on the cell-open token so the td/th
        // render rule can draw the checklist.
        const inline = tokens[i + 1];
        if (!inline || inline.type !== "inline") continue;
        const segments = buildCellSegments(inline.content, () => taskIndex++);
        if (segments.some((s) => s.kind === "checkbox")) {
          tok.meta = { ...(tok.meta as object), cellSegments: segments };
        }
        continue;
      }

      if (tok.type !== "list_item_open") continue;
      // Find the inline token inside this list item (list_item_open →
      // paragraph_open → inline).
      const inline = tokens[i + 2];
      if (!inline || inline.type !== "inline" || !inline.children?.length) continue;
      const firstText = inline.children.find((c) => c.type === "text");
      if (!firstText) continue;
      const m = /^\[([ xX])\]\s?/.exec(firstText.content);
      if (!m) continue;
      firstText.content = firstText.content.slice(m[0].length);
      tokens[i].meta = {
        ...(tokens[i].meta as object),
        isTask: true,
        checked: m[1].toLowerCase() === "x",
        taskIndex,
      };
      taskIndex += 1;
    }
    return true;
  });
}

/** A rendered piece of a table cell: literal text or a checkbox. */
type CellSegment =
  | { kind: "text"; text: string }
  | { kind: "checkbox"; checked: boolean; taskIndex: number };

/**
 * Split a table cell's raw text into ordered text / checkbox segments. `next()`
 * hands back (and advances) the shared document-order task index so cell
 * checkboxes line up with list-item checkboxes for toggleCheckboxInSource. The
 * leading list marker (`- `) and surrounding `<br>` are dropped from the text so
 * the checklist renders cleanly.
 */
function buildCellSegments(raw: string, next: () => number): CellSegment[] {
  const segments: CellSegment[] = [];
  const re = new RegExp(CELL_CHECKBOX_RE.source, CELL_CHECKBOX_RE.flags);
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  const pushText = (text: string) => {
    // Strip literal <br> tags (used as in-cell line breaks) → newlines.
    const cleaned = text.replace(/<br\s*\/?>/gi, "\n");
    if (cleaned) segments.push({ kind: "text", text: cleaned });
  };
  while ((m = re.exec(raw)) !== null) {
    const lead = m[1] ?? "";
    // Keep the boundary char (space/newline) but drop the list marker.
    const boundary = /^<br/i.test(lead) ? "\n" : lead;
    pushText(raw.slice(lastIndex, m.index) + boundary);
    segments.push({ kind: "checkbox", checked: m[3].toLowerCase() === "x", taskIndex: next() });
    lastIndex = re.lastIndex;
  }
  pushText(raw.slice(lastIndex));
  return segments;
}

/**
 * markdown-it plugin: strip the `[!type] Title` header line from callout
 * blockquotes so it isn't rendered twice (the render rule draws its own title).
 * The header lives as the first text child of the blockquote's inline token,
 * followed by a softbreak — we clear both and stash the parsed meta on the
 * blockquote_open token.
 */
function calloutPlugin(md: MdItLike) {
  md.core.ruler.after("inline", "cairn_callouts", (state) => {
    const tokens = state.tokens as MdToken[];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "blockquote_open") continue;
      // blockquote_open → paragraph_open → inline
      const inline = tokens[i + 2];
      if (!inline || inline.type !== "inline" || !inline.children?.length) continue;
      const kids = inline.children;
      const first = kids[0];
      if (!first || first.type !== "text") continue;
      const m = /^\[!([^\]]+)\]\s*(.*)$/.exec(first.content);
      if (!m) continue;
      // Drop the header text token; also drop a leading softbreak so the body
      // starts on the next line without a blank first row.
      kids.shift();
      if (kids[0] && kids[0].type === "softbreak") kids.shift();
      inline.content = kids.map((k) => k.content).join("");
      tokens[i].meta = {
        ...(tokens[i].meta as object),
        callout: { type: m[1].trim().toLowerCase(), title: m[2].trim() || undefined },
      };
    }
    return true;
  });
}

// Minimal structural types for the markdown-it plugin (no @types/markdown-it).
interface MdToken {
  type: string;
  content: string;
  meta?: unknown;
  children?: MdToken[] | null;
}
interface MdItLike {
  core: {
    ruler: {
      after: (after: string, name: string, fn: (state: { tokens: unknown[] }) => boolean) => void;
    };
  };
}

/**
 * markdown-it plugin: KaTeX-style math. Adds a block rule for `$$…$$` (emits a
 * `math_block` token) and an inline rule for `$…$` (emits `math_inline`). The
 * LaTeX source lands in token.content; render rules hand it to MathView.
 *
 * Typed loosely against markdown-it's runtime shapes (no @types/markdown-it);
 * the logic mirrors the common markdown-it-texmath dollar rules.
 */
 
function mathPlugin(md: any) {
  // Inline: $...$  (no space right after the opening $, not a lone $)
  md.inline.ruler.after("escape", "math_inline", (state: any, silent: boolean) => {
    const start = state.pos;
    if (state.src[start] !== "$") return false;
    // Escaped \$ handled by the escape rule already.
    const next = state.src[start + 1];
    if (next === undefined || next === " " || next === "$") return false;
    let end = start + 1;
    while (end < state.posMax) {
      if (state.src[end] === "$" && state.src[end - 1] !== "\\" && state.src[end - 1] !== " ") break;
      end += 1;
    }
    if (end >= state.posMax || state.src[end] !== "$") return false;
    const content = state.src.slice(start + 1, end);
    if (!content.trim()) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = content;
      token.markup = "$";
    }
    state.pos = end + 1;
    return true;
  });

  // Block: a line that is exactly $$ ... $$ (single or multi-line).
  md.block.ruler.before(
    "fence",
    "math_block",
    (state: any, startLine: number, endLine: number, silent: boolean) => {
      const startPos = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      if (startPos + 2 > max) return false;
      if (state.src.slice(startPos, startPos + 2) !== "$$") return false;
      // Find the closing $$.
      let nextLine = startLine;
      let haveEnd = false;
      let firstLine = state.src.slice(startPos + 2, max);
      if (firstLine.trim().endsWith("$$")) {
        firstLine = firstLine.trim().replace(/\$\$$/, "");
        haveEnd = true;
      }
      const buf: string[] = firstLine ? [firstLine] : [];
      while (!haveEnd) {
        nextLine += 1;
        if (nextLine >= endLine) break;
        const from = state.bMarks[nextLine] + state.tShift[nextLine];
        const to = state.eMarks[nextLine];
        const line = state.src.slice(from, to);
        if (line.trim().endsWith("$$")) {
          buf.push(line.trim().replace(/\$\$$/, ""));
          haveEnd = true;
        } else {
          buf.push(line);
        }
      }
      if (!haveEnd) return false;
      if (silent) return true;
      state.line = nextLine + 1;
      const token = state.push("math_block", "math", 0);
      token.block = true;
      token.content = buf.join("\n").trim();
      token.markup = "$$";
      return true;
    },
  );
}
 


/** Custom render rules — code fences, callouts, highlight, checkboxes, swatches. */
function makeRules(
  t: Theme,
  source: string,
  onChangeContent?: (next: string) => void,
  onHeadingLayout?: (id: string, y: number) => void,
  onLinkPress?: (url: string) => void,
): RenderRules {
  // Callout type → { colour token, icon }. Mirrors the desktop getCalloutConfig
  // (src/components/notes/Callout.tsx) exactly, including aliases, so a note
  // renders identically on both platforms. Every colour is a theme token, so
  // callouts flip with the OS colour scheme (full dark-mode support).
  const calloutConfig = (type: string): { color: string; Icon: LucideIcon } => {
    switch (type) {
      case "tip":
        return { color: t.success, Icon: Lightbulb };
      case "warning":
        return { color: t.warning, Icon: AlertTriangle };
      case "danger":
      case "caution":
      case "error":
        return { color: t.danger, Icon: AlertCircle };
      case "success":
      case "check":
      case "done":
        return { color: t.success, Icon: CheckCircle2 };
      case "question":
      case "faq":
        return { color: t.accent, Icon: HelpCircle };
      case "quote":
      case "cite":
        return { color: t.textTertiary, Icon: Quote };
      // note / info / fallback
      default:
        return { color: t.accent, Icon: Info };
    }
  };

  // Render a table cell. When taskListPlugin recorded checkbox segments on the
  // cell (a GFM checklist crammed into one cell), draw the text + tappable
  // checkbox icons ourselves; otherwise fall back to the default children.
  const renderTableCell = (
    node: ASTNode,
    children: ReactNode,
    textStyle: StyleProp<TextStyle>,
  ): ReactNode => {
    const segments = (node as { sourceMeta?: { cellSegments?: CellSegment[] } }).sourceMeta
      ?.cellSegments;
    const cellStyle = { flex: 1, padding: 8 } as const;
    if (!segments || segments.length === 0) {
      return (
        <View key={node.key} style={cellStyle}>
          {children}
        </View>
      );
    }
    const interactive = !!onChangeContent;
    return (
      <View key={node.key} style={cellStyle}>
        <Text style={textStyle}>
          {segments.map((seg, i) => {
            if (seg.kind === "text") return <Text key={i}>{seg.text}</Text>;
            return (
              <Text
                key={i}
                onPress={
                  interactive
                    ? () => onChangeContent?.(toggleCheckboxInSource(source, seg.taskIndex))
                    : undefined
                }
              >
                {seg.checked ? (
                  <CheckSquare size={15} color={t.accent} />
                ) : (
                  <Square size={15} color={t.textTertiary} />
                )}
                {" "}
              </Text>
            );
          })}
        </Text>
      </View>
    );
  };

  return {
    // Syntax-highlighted fenced / indented code blocks; mermaid → diagram.
    fence: (node) => {
      const lang = extractFenceLang(node);
      if (lang === "mermaid")
        return (
          <Suspense key={node.key} fallback={<View style={{ height: 60 }} />}>
            <MermaidView code={node.content} />
          </Suspense>
        );
      return <CodeBlock key={node.key} code={node.content} language={lang} />;
    },
    code_block: (node) => <CodeBlock key={node.key} code={node.content} />,

    // KaTeX math (from mathPlugin).
    math_inline: (node) => (
      <Suspense key={node.key} fallback={<Text> </Text>}>
        <MathView latex={node.content} display={false} />
      </Suspense>
    ),
    math_block: (node) => (
      <Suspense key={node.key} fallback={<View style={{ height: 40 }} />}>
        <MathView latex={node.content} display={true} />
      </Suspense>
    ),

    // ==highlight== → mark chip. Matches desktop: accent @ 22%.
    mark: (node, children) => (
      <Text
        key={node.key}
        style={{
          backgroundColor: withAlpha(t.accent, 0.22),
          color: t.textPrimary,
        }}
      >
        {children}
      </Text>
    ),

    // A blockquote tagged by calloutPlugin renders as a coloured callout; the
    // `[!type] Title` header line has already been stripped from the children.
    blockquote: (node, children, _parent, styles) => {
      const meta = (node as { sourceMeta?: { callout?: { type: string; title?: string } } }).sourceMeta;
      const callout = meta?.callout;
      if (callout) {
        const { color, Icon } = calloutConfig(callout.type);
        const title =
          callout.title ||
          callout.type.charAt(0).toUpperCase() + callout.type.slice(1);
        return (
          <View
            key={node.key}
            style={{
              // Opaque surface-anchored fill + muted border, matching the desktop
              // color-mix(... var(--surface)) / 30%-transparent border.
              backgroundColor: surfaceTint(color, 0.08, t.surface),
              borderColor: withAlpha(color, 0.3),
              borderWidth: 1,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
              marginBottom: 12,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                marginBottom: 4,
              }}
            >
              <Icon size={14} color={color} />
              <Text
                style={{
                  color,
                  fontWeight: "600",
                  fontSize: 13,
                  flex: 1,
                }}
              >
                {title}
              </Text>
            </View>
            <View style={{ opacity: 0.92 }}>{children}</View>
          </View>
        );
      }
      return (
        <View key={node.key} style={styles.blockquote}>
          {children}
        </View>
      );
    },

    // Task-list checkboxes (tagged by taskListPlugin) render an icon in place of
    // the bullet; plain list items keep the default bullet/number.
    list_item: (node, children, parent, _styles) => {
      const meta = (node as { sourceMeta?: { isTask?: boolean; checked?: boolean; taskIndex?: number } })
        .sourceMeta;
      if (meta?.isTask) {
        const checked = !!meta.checked;
        const index = meta.taskIndex ?? 0;
        const interactive = !!onChangeContent;
        return (
          <View key={node.key} style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 4 }}>
            <Pressable
              disabled={!interactive}
              hitSlop={8}
              onPress={() => onChangeContent?.(toggleCheckboxInSource(source, index))}
              style={{ paddingTop: 2, paddingRight: 8 }}
            >
              {checked ? (
                <CheckSquare size={17} color={t.accent} />
              ) : (
                <Square size={17} color={t.textTertiary} />
              )}
            </Pressable>
            <View style={{ flex: 1 }}>{children}</View>
          </View>
        );
      }

      // Plain list item — mirror the library's default bullet / ordered marker
      // so non-task lists look identical to before. Inline the marker style with
      // a fixed width so the dot always shows regardless of style merging.
      const ordered = hasParentType(parent, "ordered_list");
      return (
        <View key={node.key} style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 4 }}>
          <Text
            accessible={false}
            style={{
              color: ordered ? t.textSecondary : t.accent,
              width: ordered ? 22 : 16,
              lineHeight: 15 * 1.7,
              fontWeight: "700",
            }}
          >
            {ordered ? `${(node.index ?? 0) + 1}.` : "\u2022"}
          </Text>
          <View style={{ flex: 1 }}>{children}</View>
        </View>
      );
    },

    // Table cells. If taskListPlugin found checkbox tokens in the cell, render
    // the reconstructed text/checkbox segments ourselves (with tappable icons)
    // instead of the default inline children — GFM cells can hold a whole
    // checklist that markdown-it leaves as literal `[ ]` text.
    td: (node, children, _parent, styles) =>
      renderTableCell(node, children, styles.td),
    th: (node, children, _parent, styles) =>
      renderTableCell(node, children, styles.th),

    // Inline code — render a colour swatch before CSS colour literals.
    code_inline: (node, _children, _parent, styles) => {
      const text = node.content ?? "";
      const swatch = isColorLiteral(text) ? text.trim() : null;
      return (
        <Text key={node.key} style={styles.code_inline}>
          {swatch ? (
            <Text>
              <Text style={{ color: swatch }}>{"\u25A0 "}</Text>
              {text}
            </Text>
          ) : (
            text
          )}
        </Text>
      );
    },

    // Links. Cairn wikilinks (cairn://note|task/…) are resolved live against the
    // local DB: resolved → accent wikilink chip that navigates; UNRESOLVED →
    // dimmed, non-tappable text (desktop parity — a dead [[link]] must not
    // navigate to an empty note screen). External links render as a plain accent
    // underline link.
    link: (node, children, _parent, styles) => {
      const href = (node.attributes as { href?: string } | undefined)?.href ?? "";
      if (cairnLinkResolution(href) === "cairn") {
        if (!isCairnLinkResolved(href)) {
          // Dead wikilink — dim and swallow taps (matches desktop text-tertiary/60%).
          return (
            <Text key={node.key} style={{ color: t.textTertiary, opacity: 0.6 }} onPress={() => {}}>
              {children}
            </Text>
          );
        }
        // Resolved wikilink — accent chip on a faint accent wash (desktop parity).
        return (
          <Text
            key={node.key}
            style={{ color: t.accent, backgroundColor: withAlpha(t.accent, 0.1), fontWeight: "500" }}
            onPress={() => onLinkPress?.(href)}
          >
            {children}
          </Text>
        );
      }
      // External / other link — plain accent underline.
      return (
        <Text key={node.key} style={styles.link} onPress={() => onLinkPress?.(href)}>
          {children}
        </Text>
      );
    },

    // Headings (h1–h3): render as normal but wrap in an onLayout reporter so the
    // Table of Contents can scroll to each by its GitHub-style slug. h4–h6 fall
    // through to the library defaults (not shown in the TOC).
    heading1: (node, children, _parent, styles) =>
      renderHeading(node, children, styles.heading1, onHeadingLayout),
    heading2: (node, children, _parent, styles) =>
      renderHeading(node, children, styles.heading2, onHeadingLayout),
    heading3: (node, children, _parent, styles) =>
      renderHeading(node, children, styles.heading3, onHeadingLayout),
  };
}

/** Flatten an AST node's text content (for heading slugging). */
function nodeText(node: ASTNode): string {
  if (node.content) return node.content;
  const kids = (node.children ?? []) as ASTNode[];
  return kids.map(nodeText).join("");
}

/** Classify a link href: "cairn" for internal note/task wikilinks, else "external". */
function cairnLinkResolution(href: string): "cairn" | "external" {
  return noteTitleFromUrl(href) != null || cardIdFromUrl(href) != null ? "cairn" : "external";
}

/**
 * True if a cairn:// wikilink resolves to a live note or card. A note-body link
 * carries a title (resolve by title, or by id if it names a live note); a chat
 * link carries a baked id (resolve by id, or title as a fallback). Mirrors the
 * desktop "resolved" check so unresolved links can render dimmed + inert.
 */
function isCairnLinkResolved(href: string): boolean {
  const cardId = cardIdFromUrl(href);
  if (cardId != null) {
    return liveCardTitleById(cardId) != null || findCardIdByTitle(cardId) != null;
  }
  const noteRef = noteTitleFromUrl(href);
  if (noteRef != null) {
    return findNoteIdByTitle(noteRef) != null || liveNoteTitleById(noteRef) != null;
  }
  return false;
}

/** Render a heading with its themed style, wrapped in an onLayout reporter. */
function renderHeading(
  node: ASTNode,
  children: ReactNode,
  style: object,
  onHeadingLayout?: (id: string, y: number) => void,
): ReactNode {
  const id = headingSlug(nodeText(node));
  return (
    <View
      key={node.key}
      onLayout={onHeadingLayout ? (e) => onHeadingLayout(id, e.nativeEvent.layout.y) : undefined}
    >
      <Text style={style}>{children}</Text>
    </View>
  );
}

/** Pull the fenced-code language from the token's info string. */
function extractFenceLang(node: ASTNode): string | undefined {
  const info = (node as { sourceInfo?: string }).sourceInfo;
  if (!info) return undefined;
  return info.trim().split(/\s+/)[0] || undefined;
}

/** True if any ancestor node is a list of the given type. */
function hasParentType(parents: ASTNode[], type: string): boolean {
  return parents.some((p) => p.type === type);
}

// ── Styles ── tuned to match the desktop .prose-cairn spec (globals.css:357).
// Desktop base is 0.875rem @ line-height 1.7; headings h1 1.5rem/700,
// h2 1.2rem/600, h3 1rem/600; tight paragraph/list margins.
function markdownStyles(t: Theme) {
  const mono = "Menlo";
  const BASE = 15;
  const LINE = BASE * 1.7;
  return {
    body: { color: t.textPrimary, fontSize: BASE, lineHeight: LINE },
    heading1: { color: t.textPrimary, fontSize: 24, fontWeight: "700" as const, marginTop: 20, marginBottom: 8, lineHeight: 30 },
    heading2: { color: t.textPrimary, fontSize: 20, fontWeight: "600" as const, marginTop: 16, marginBottom: 6, lineHeight: 26 },
    heading3: { color: t.textPrimary, fontSize: 17, fontWeight: "600" as const, marginTop: 12, marginBottom: 4, lineHeight: 23 },
    heading4: { color: t.textPrimary, fontSize: 15, fontWeight: "600" as const, marginTop: 10, marginBottom: 4 },
    heading5: { color: t.textSecondary, fontSize: 14, fontWeight: "600" as const, marginTop: 8 },
    heading6: { color: t.textSecondary, fontSize: 13, fontWeight: "600" as const, marginTop: 8 },
    paragraph: { color: t.textPrimary, marginTop: 8, marginBottom: 8, lineHeight: LINE },
    strong: { fontWeight: "600" as const, color: t.textPrimary },
    em: { fontStyle: "italic" as const },
    s: { textDecorationLine: "line-through" as const, color: t.textTertiary },
    link: { color: t.accent, textDecorationLine: "underline" as const },
    blockquote: {
      // The library default fills blockquotes with #F5F5F5 / #CCC — override
      // both so plain (non-callout) blockquotes read on dark. Desktop: no fill,
      // left border = border token, text = text-secondary (RN can't cascade the
      // text colour into nested paragraphs, so those stay text-primary).
      backgroundColor: "transparent",
      borderColor: t.border,
      borderLeftColor: t.border,
      borderLeftWidth: 3,
      paddingHorizontal: 14,
      paddingVertical: 4,
      marginVertical: 12,
    },
    code_inline: {
      color: t.textPrimary,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      fontFamily: mono,
      fontSize: 13,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 3,
    },
    // fence / code_block are handled by the CodeBlock rule; keep minimal styles
    // as a fallback in case a rule is bypassed.
    code_block: { color: t.textPrimary, backgroundColor: t.surface2, fontFamily: mono, fontSize: 13, padding: 12, borderRadius: 8, marginBottom: 12 },
    fence: { color: t.textPrimary, backgroundColor: t.surface2, fontFamily: mono, fontSize: 13, padding: 12, borderRadius: 8, marginBottom: 12 },
    bullet_list: { marginVertical: 8 },
    ordered_list: { marginVertical: 8 },
    // Row layout comes from the library default; we add spacing + alignment.
    list_item: { flexDirection: "row" as const, justifyContent: "flex-start" as const, alignItems: "flex-start" as const, marginBottom: 4 },
    bullet_list_content: { flex: 1 },
    ordered_list_content: { flex: 1 },
    bullet_list_icon: { color: t.accent, marginRight: 8, lineHeight: LINE },
    ordered_list_icon: { color: t.textSecondary, marginRight: 8, lineHeight: LINE },
    hr: { backgroundColor: t.border, height: 1, marginVertical: 16 },
    table: { borderColor: t.border, borderWidth: 1, borderRadius: 6, marginVertical: 12 },
    thead: { backgroundColor: t.surface2 },
    th: { color: t.textPrimary, padding: 8, fontWeight: "600" as const },
    tr: { borderBottomColor: t.border, borderBottomWidth: 1 },
    td: { color: t.textPrimary, padding: 8 },
    image: { borderRadius: 8, marginVertical: 8 },
  };
}
