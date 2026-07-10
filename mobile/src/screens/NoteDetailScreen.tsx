import { useLocalSearchParams, Stack, useRouter, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ScrollView,
  Text,
  StyleSheet,
  View,
  Alert,
} from "react-native";
import { Pin, List } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getNote, updateNote, tagsForNote, noteTagIds, setNoteTags, pinNote, softDeleteNote, workspaceIdForNote } from "@/db/queries";
import { MarkdownView } from "@/components/MarkdownView";
import { TagChips } from "@/components/TagChips";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { NoteEditorBody } from "@/components/NoteEditorBody";
import { PressableScale } from "@/components/PressableScale";
import { ResultRow } from "@/components/ResultRow";
import { NotFound } from "@/components/NotFound";
import { BottomSheet, BottomSheetHeader } from "@/components/BottomSheet";
import { GlassBar, glassActive } from "@/components/GlassBar";
import { ICON_CHECK, ICON_CLOSE, ICON_EDIT, ICON_MORE, ICON_PIN, ICON_UNPIN, ICON_TAG, ICON_DELETE } from "@/components/toolbar-icons";
import { useNoteFormattingToolbar } from "@/notes/useNoteFormattingToolbar";
import { reindexNote, relatedNotes, type RelatedNote } from "@/notes/embeddings";
import { haptics, toolbarPress } from "@/haptics";
import { extractHeadings } from "@cairn/shared/notes/toc";
import { isAppleEmbeddingsSupported } from "@modules/apple-embeddings";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { useTheme, TAB_BAR_BASE, type as typeScale, type Theme } from "@/theme";

/**
 * Note viewer / editor. A leaf screen (navigates only back), so both its routes
 * (root `app/note/[id]` and Projects-tab `app/(tabs)/projects/note/[id]`) render it
 * unchanged; the containing stack decides whether the tab bar stays visible.
 *
 * `nested` = rendered inside the Projects tab (tab bar visible), so the read
 * view adds tab-bar bottom padding; root-stack copies (Search/Graph/Conflicts)
 * pass it false.
 */
export function NoteDetailScreen({ nested = false }: { nested?: boolean }) {
  const { id, back } = useLocalSearchParams<{ id: string; back?: string }>();
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // Bottom padding so the note body scrolls clear of the bottom safe area.
  // `insets.bottom` already includes the native tab bar on a tab screen (see
  // TAB_BAR_BASE doc), so we no longer add it separately; the +40 is scroll
  // slack so the last line isn't flush against the bar / home indicator.
  const viewBottomPad = 40 + insets.bottom;
  const [note, setNote] = useState(() => (id ? getNote(id) : null));

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.content ?? "");
  const [tagPickerOpen, setTagPickerOpen] = useState(false);

  // Editing toolbar state.
  const fmt = useNoteFormattingToolbar(body, setBody);

  // Table-of-contents: headings parsed from the current body, the read-mode
  // scroll view, and per-heading y-offsets reported by MarkdownView (relative to
  // its own container) plus that container's offset within the scroll content.
  const [tocOpen, setTocOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const headingY = useRef<Map<string, number>>(new Map());
  const mdOffsetY = useRef(0);
  const headings = useMemo(() => extractHeadings(note?.content ?? ""), [note?.content]);

  const scrollToHeading = useCallback((slugId: string) => {
    setTocOpen(false);
    const local = headingY.current.get(slugId);
    if (local == null) return;
    const y = Math.max(0, mdOffsetY.current + local - 12);
    scrollRef.current?.scrollTo({ y, animated: true });
  }, []);

  const styles = useMemo(() => makeStyles(t), [t]);

  // Re-read the note when the screen refocuses or inbound sync lands changes,
  // so the view reflects edits made on another device. Skip while editing so we
  // never clobber the user's in-progress changes.
  const reload = useCallback(() => {
    if (editing || !id) return;
    const fresh = getNote(id);
    if (!fresh) return;
    setNote(fresh);
    setTitle(fresh.title ?? "");
    setBody(fresh.content ?? "");
  }, [editing, id]);
  useRefreshOnFocus(reload);

  const isPinned = !!note?.is_pinned;

  const onPin = useCallback(() => {
    if (!note) return;
    pinNote(note.id, !isPinned);
    setNote(getNote(note.id));
  }, [note, isPinned]);

  const onTags = useCallback((tagIds: string[]) => {
    if (!note) return;
    setNoteTags(note.id, tagIds);
    setNote(getNote(note.id));
    setTagPickerOpen(false);
  }, [note]);

  // Toggling a task-list checkbox in the rendered preview rewrites the source
  // and persists immediately (mirrors the desktop live-preview toggle).
  const onToggleCheckbox = useCallback(
    (next: string) => {
      if (!note) return;
      updateNote(note.id, note.title ?? "Untitled", next);
      const fresh = getNote(note.id);
      setNote(fresh);
      setBody(fresh?.content ?? next);
    },
    [note],
  );

  const onDelete = useCallback(() => {
    if (!note) return;
    Alert.alert("Delete note?", "This removes the note on all your devices. This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          haptics.warning();
          softDeleteNote(note.id);
          router.back();
        },
      },
    ]);
  }, [note, router]);

  if (!note) {
    return <NotFound label="Note" />;
  }

  const onSave = () => {
    updateNote(note.id, title.trim() || "Untitled", body);
    setNote(getNote(note.id));
    setEditing(false);
    haptics.success(); // note saved
    // Refresh the on-device semantic index for just this note (incremental,
    // hash-gated, no-op when embeddings are unavailable). Fire-and-forget.
    reindexNote(note.id).catch(() => {});
  };
  const onCancel = () => {
    setTitle(note.title ?? "");
    setBody(note.content ?? "");
    setEditing(false);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: editing ? "Edit note" : note.title || "Note",
          // Callers reaching this over the tab navigator (Graph/Search/Conflicts)
          // pass an explicit `back` label since the root stack can't infer the
          // origin tab's title; the in-tab Projects flow omits it.
          ...(back ? { headerBackTitle: back } : {}),
        }}
      />
      {editing ? (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button icon={ICON_CLOSE} accessibilityLabel="Cancel" onPress={toolbarPress(onCancel)}>
              Cancel
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button icon={ICON_CHECK} variant="done" accessibilityLabel="Save" onPress={toolbarPress(onSave)}>
              Save
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        </>
      ) : (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu icon={ICON_MORE} accessibilityLabel="Note actions">
            <Stack.Toolbar.MenuAction
              icon={isPinned ? ICON_UNPIN : ICON_PIN}
              isOn={isPinned}
              onPress={toolbarPress(onPin)}
            >
              {isPinned ? "Unpin" : "Pin"}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon={ICON_TAG} onPress={toolbarPress(() => setTagPickerOpen(true))}>
              Edit tags
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon={ICON_DELETE} destructive onPress={toolbarPress(onDelete)}>
              Delete
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Button icon={ICON_EDIT} accessibilityLabel="Edit" onPress={toolbarPress(() => setEditing(true))}>
            Edit
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}

      {editing ? (
        <NoteEditorBody
          title={title}
          body={body}
          onTitle={setTitle}
          onBody={setBody}
          fmt={fmt}
          bottomInset={insets.bottom + (nested ? TAB_BAR_BASE : 0)}
        />
      ) : (
        <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={[styles.content, { paddingBottom: viewBottomPad }]}>
          <View style={styles.titleRow}>
            {isPinned && <Pin size={16} color={t.accent} fill={t.accent} />}
            <Text style={styles.title}>{note.title || "Untitled"}</Text>
          </View>
          {note.folder ? <Text style={styles.folder}>{note.folder}</Text> : null}
          <TagChipsRow note={note} />
          <View
            style={styles.md}
            onLayout={(e) => { mdOffsetY.current = e.nativeEvent.layout.y; }}
          >
            <MarkdownView
              content={note.content ?? ""}
              onChangeContent={onToggleCheckbox}
              onHeadingLayout={(headingId, y) => headingY.current.set(headingId, y)}
            />
          </View>
          <RelatedNotes
            noteId={note.id}
            onOpen={(nid) => router.push({ pathname: "/note/[id]", params: { id: nid, back: "Note" } })}
          />
        </ScrollView>
      )}

      {/* Floating Table-of-Contents button — read mode only, and only when the
          note has enough structure to be worth jumping around (≥2 headings).
          A glass pill bottom-right. `insets.bottom` already reserves the native
          tab bar's area (the bar extends into the home-indicator inset), so we
          add only a small fixed gap — NOT TAB_BAR_BASE, which would double-count
          in the nested (tab-bar-visible) flow and float the button too high. */}
      {!editing && headings.length >= 2 ? (
        <View
          style={[styles.tocFab, { bottom: 12 + insets.bottom }]}
          pointerEvents="box-none"
        >
          <PressableScale onPress={() => setTocOpen(true)} haptic={false} accessibilityLabel="Table of contents">
            <GlassBar style={[styles.tocFabInner, !glassActive && styles.tocFabFallback]}>
              <List size={22} color={t.textPrimary} />
            </GlassBar>
          </PressableScale>
        </View>
      ) : null}

      <BottomSheet visible={tocOpen} onClose={() => setTocOpen(false)} maxHeight="70%">
        <BottomSheetHeader title="On this page" onCancel={() => setTocOpen(false)} />
        <ScrollView style={styles.tocList} contentContainerStyle={styles.tocListContent}>
          {headings.map((h, i) => (
            <PressableScale
              key={`${h.id}-${i}`}
              style={styles.tocRow}
              onPress={() => scrollToHeading(h.id)}
            >
              <Text
                style={[
                  styles.tocItem,
                  h.level === 2 && styles.tocItemL2,
                  h.level === 3 && styles.tocItemL3,
                ]}
                numberOfLines={1}
              >
                {h.text}
              </Text>
            </PressableScale>
          ))}
        </ScrollView>
      </BottomSheet>

      <TagPickerSheet
        visible={tagPickerOpen}
        initialSelected={noteTagIds(note)}
        onDone={onTags}
        onClose={() => setTagPickerOpen(false)}
      />
    </View>
  );
}

function TagChipsRow({ note }: { note: { tag_ids: string } }) {
  const tags = tagsForNote(note);
  if (!tags.length) return null;
  return (
    <View style={{ marginTop: 10 }}>
      <TagChips tags={tags} size="sm" />
    </View>
  );
}

/**
 * "Related notes" — on-device semantic neighbours of the current note, surfaced
 * below the body. Reuses relatedNotes() (corpus-centred cosine). Renders nothing
 * when embeddings are unavailable, the note isn't indexed yet, or there are no
 * matches above the similarity floor — so it never shows an empty shell.
 */
function RelatedNotes({ noteId, onOpen }: { noteId: string; onOpen: (id: string) => void }) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [items, setItems] = useState<RelatedNote[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!isAppleEmbeddingsSupported()) {
        setItems([]);
        return;
      }
      let alive = true;
      relatedNotes(workspaceIdForNote(noteId), noteId, 5)
        .then((r) => { if (alive) setItems(r); })
        .catch(() => { if (alive) setItems([]); });
      return () => { alive = false; };
    }, [noteId]),
  );

  if (!items || items.length === 0) return null;

  return (
    <View style={styles.related}>
      <Text style={styles.relatedHeading}>Related notes</Text>
      {items.map((r) => (
        <ResultRow key={r.noteId} title={r.title} score={r.score} onPress={() => onOpen(r.noteId)} />
      ))}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    scroll: { flex: 1 },
    content: { padding: 18, paddingBottom: 64 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { ...typeScale.display, color: t.textPrimary, flexShrink: 1 },
    folder: { ...typeScale.caption, color: t.accent, marginTop: 4, marginBottom: 4 },
    md: { marginTop: 12 },
    // Related notes (semantic neighbours)
    related: {
      marginTop: 28,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
      paddingTop: 16,
    },
    relatedHeading: {
      ...typeScale.overline,
      color: t.textTertiary,
      marginBottom: 8,
    },
    // Floating TOC button
    tocFab: { position: "absolute", right: 18 },
    tocFabInner: {
      width: 52,
      height: 52,
      borderRadius: 26,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    tocFabFallback: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border },
    // TOC sheet list
    tocList: { maxHeight: 460 },
    tocListContent: { paddingHorizontal: 12, paddingVertical: 8 },
    tocRow: { paddingVertical: 11, paddingHorizontal: 8, borderRadius: 8 },
    // One uniform text size for every TOC item (control) so it scales with the
    // font-scale setting; heading hierarchy is conveyed by indent + colour +
    // weight only, never a per-level font size.
    tocItem: { ...typeScale.control, color: t.textPrimary, fontWeight: "600" },
    tocItemL2: { paddingLeft: 16, color: t.textSecondary, fontWeight: "500" },
    tocItemL3: { paddingLeft: 32, color: t.textTertiary, fontWeight: "400" },
  });
}
