import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View, useWindowDimensions, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Host } from "@expo/ui";
import { NavigationStack } from "@expo/ui/swift-ui";
import { onHingeChange, type HingeStatus } from "@expo/ui/swift-ui/modifiers";
import { lastHingeStatus, rememberHingeStatus } from "@/lib/hinge";
import { FOLD_GUTTER } from "@/lib/fold";
import { useFold, useTopHalf } from "@/lib/use-fold";
// NOTE (SDK 58): useHeaderHeight has no public expo-router export (see app/picker/due-date.tsx).
import { useHeaderHeight } from "expo-router/build/react-navigation/elements/index";
import { useTheme } from "@/theme";
import { ChromeColumn } from "@/components/screen-chrome";
import { NoteDetailScreen } from "@/screens/NoteDetailScreen";
import { CardDetailScreen } from "@/screens/CardDetailScreen";
import { ProjectScreen } from "@/screens/ProjectScreen";
import { showProjectInSplitView } from "@/components/ProjectsSplitView";

/**
 * Side preview — on wide windows (unfolded iPhone Duo, iPad) a note or task the
 * user picks on a tab screen (chat, graph, calendar, …) opens in a column beside
 * that screen instead of pushing a full-screen route, like the desktop. Half open
 * on a Duo, the screen and the preview sit on either side of the hinge; folded,
 * the preview fills the window and its ✕ returns to the screen.
 *
 * One implementation for every tab, so they can't drift:
 *   const sp = useSidePreview({ title: "Graph" });
 *   <Stack.Screen options={sp.screenOptions} />
 *   {sp.showToolbar && <Stack.Toolbar …/>}            // the pane's bar owns the rail while open
 *   <SidePreviewLayout state={sp}> …screen body… </SidePreviewLayout>
 * and open items with `useOpenInPreview()` (falls back to navigating when there
 * is no pane, e.g. Android or outside a SidePreviewLayout).
 */

export interface PreviewRef {
  kind: "note" | "card" | "project";
  id: string;
}

/** The pane is SwiftUI (`@expo/ui`), so previews exist on iOS only. */
export const SIDE_PREVIEW_SUPPORTED = Platform.OS === "ios";

/** Opens a ref in the preview column; null when there's no pane to open it in. */
const SidePreviewContext = createContext<((ref: PreviewRef) => void) | null>(null);
export const SidePreviewProvider = SidePreviewContext.Provider;
/** The opener, or null when previews aren't available here (caller navigates instead). */
export function useOpenInPreview() {
  return useContext(SidePreviewContext);
}

/** Below this width the screen stays single-column (previews fill the window when open). */
export const SIDE_PREVIEW_MIN_WIDTH = 700;

export interface SidePreviewState {
  preview: PreviewRef | null;
  setPreview: (ref: PreviewRef | null) => void;
  /**
   * Opens a note/task in the pane, or null when previews aren't available (the
   * caller then navigates to the full-screen route). Use from the screen itself;
   * descendants use `useOpenInPreview()`.
   */
  open: ((ref: PreviewRef) => void) | null;
  /** Wide enough for a column beside the screen (and a pane exists). */
  wide: boolean;
  /**
   * Laptop pose (portrait half-fold): the preview opens in the upright top half
   * and the screen keeps the flat bottom half, instead of a column beside it.
   */
  stacked: boolean;
  /** Folded with a preview open: the pane owns the whole window. */
  fills: boolean;
  /** Whether the screen's own toolbar items should render (the pane's bar owns the rail while open). */
  showToolbar: boolean;
  /** Spread into `<Stack.Screen options>`: transparent header when wide, none when the pane fills. */
  screenOptions: Record<string, unknown>;
  /** Top inset the screen body adds itself when the header is transparent (wide). */
  contentPaddingTop: number;
}

/**
 * Preview state + the header/safe-area treatment every previewing tab needs.
 * Wide windows drop the header bar (it only titled the screen and pushed the
 * preview column down) but keep the toolbar items, which dock into the Duo's
 * side rail; folded with a preview open, the pane's own bar is the only one.
 */
export function useSidePreview({
  title,
  titleWhenWide = true,
}: {
  title: string;
  /**
   * Keep the screen title on wide windows (until a preview opens — the pane's own
   * bar owns the top then, and a window-centred title would sit over it). Chat
   * passes false: it has never shown a title beside its conversation.
   */
  titleWhenWide?: boolean;
}): SidePreviewState {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const headerHeight = useHeaderHeight();
  const [preview, setPreview] = useState<PreviewRef | null>(null);
  const fold = useFold();
  const wide = SIDE_PREVIEW_SUPPORTED && width >= SIDE_PREVIEW_MIN_WIDTH;
  const stacked = SIDE_PREVIEW_SUPPORTED && !wide && fold?.axis === "horizontal";
  const fills = SIDE_PREVIEW_SUPPORTED && !wide && !stacked && preview != null;
  // Header treatment is shared: transparent, title dropped once a preview opens
  // (its own bar owns the top), whether the pane sits beside or above the body.
  const chrome = wide || stacked;
  const screenOptions: Record<string, unknown> = {
    headerShown: !fills,
    // While a preview is open its SwiftUI pane reaches the window edge and
    // handles the side rail itself; the RN padding would double that inset.
    contentStyle:
      preview != null
        ? { backgroundColor: t.background, paddingLeft: insets.left }
        : { backgroundColor: t.background, paddingLeft: insets.left, paddingRight: insets.right },
    title: chrome && (!titleWhenWide || preview != null) ? "" : title,
    headerTransparent: chrome,
    // TabStack paints the header with the surface colour, and iOS 26 adds a
    // scroll-edge fade under it — both drew a white strip across the top.
    ...(chrome
      ? {
          headerStyle: { backgroundColor: "transparent" },
          scrollEdgeEffects: { top: "hidden", bottom: "automatic", left: "automatic", right: "automatic" },
        }
      : {}),
  };
  return {
    preview,
    setPreview,
    open: SIDE_PREVIEW_SUPPORTED ? setPreview : null,
    wide,
    stacked,
    fills,
    showToolbar: preview == null,
    screenOptions,
    contentPaddingTop: chrome ? headerHeight : 0,
  };
}

/**
 * Lays a tab screen's body beside the preview pane. Folded with a preview open
 * the body collapses (stays mounted, so scroll position and state survive) and
 * the pane fills the window.
 */
export function SidePreviewLayout({
  state,
  children,
  bodyStyle,
  onChanged,
  collapsePane = false,
}: {
  state: SidePreviewState;
  children: ReactNode;
  /**
   * Laptop pose, stacked: slide the pane away (it stays mounted, so an unsaved
   * edit survives) and give the screen the whole top half. For when the screen's
   * own input has the keyboard — the flat half — so the screen's composer rises
   * to the crease with its conversation above it.
   */
  collapsePane?: boolean;
  /** Extra style for the body column (e.g. background, top padding). */
  bodyStyle?: ViewStyle | ViewStyle[];
  /** The previewed task was saved, archived or deleted. */
  onChanged?: () => void;
}) {
  const { preview, setPreview, fills, stacked, contentPaddingTop } = state;
  const topHalf = useTopHalf();
  // Laptop pose: the pane takes the top half (above the crease) and the screen
  // body the bottom half, starting just under the crease's gutter. Collapsed, the
  // body has the whole container instead.
  const collapsed = stacked && collapsePane;
  const stackedHeight = stacked ? topHalf.before : null;
  const bodyPaddingTop = stacked && preview && !collapsed ? FOLD_GUTTER : contentPaddingTop;
  const pane = SIDE_PREVIEW_SUPPORTED && (
    <SidePreviewPane
      preview={preview}
      fill={!state.wide && !stacked}
      stackedHeight={stackedHeight}
      stackedCollapsed={collapsed}
      onClose={() => setPreview(null)}
      onChanged={onChanged}
      onOpen={setPreview}
    />
  );
  return (
    <SidePreviewProvider value={SIDE_PREVIEW_SUPPORTED ? setPreview : null}>
      <View
        onLayout={topHalf.onLayout}
        style={[styles.row, stacked && styles.column]}
      >
        {stacked && pane}
        <View style={[{ flex: 1, paddingTop: bodyPaddingTop }, bodyStyle, fills && styles.collapsed]}>{children}</View>
        {!stacked && pane}
      </View>
    </SidePreviewProvider>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row", overflow: "hidden" },
  column: { flexDirection: "column" },
  collapsed: { flex: 0, width: 0, overflow: "hidden" },
});

export function SidePreviewPane({
  preview,
  onClose,
  onChanged,
  onOpen,
  fill = false,
  stackedHeight = null,
  stackedCollapsed = false,
}: {
  /** The note / task to show; null slides the pane closed. */
  preview: PreviewRef | null;
  /**
   * Folded with a preview open: the pane takes the whole window (the chat
   * stays mounted, collapsed beside it) — Mail on a closed Duo shows the
   * message, not the list. Same component, so nothing remounts across the
   * fold and unsaved edits survive it.
   */
  fill?: boolean;
  /**
   * Laptop pose: the pane sits above the body and grows to this height (the room
   * above the crease) instead of a width. Null everywhere else.
   */
  stackedHeight?: number | null;
  /** Stacked: ease the pane's frame shut (content keeps its size, so nothing re-lays out). */
  stackedCollapsed?: boolean;
  onClose: () => void;
  /** The previewed task was saved, archived or deleted. */
  onChanged?: () => void;
  /** Swap the pane's content (a project's note/task row opens in place of the project). */
  onOpen?: (ref: PreviewRef) => void;
}) {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [hinge, setHinge] = useState<HingeStatus | null>(lastHingeStatus);
  // Same split as the Notes split view: half open on a Duo, the pane starts
  // exactly on the fold (each half its own page); fully open (flat), and on
  // iPad, the open item gets the larger share, as SwiftUI's detail column
  // does. The pane runs to the window edge (the chat screen drops its rail
  // padding while it's open).
  const paneWidth = hinge === "partiallyOpen" ? width / 2 : Math.round(width * 0.6);
  // Hinge / size changes resize the open pane smoothly instead of jumping.
  const paneW = useSharedValue(paneWidth);
  useEffect(() => {
    paneW.set(withTiming(paneWidth, { duration: 280, easing: Easing.out(Easing.cubic) }));
  }, [paneWidth, paneW]);

  // One animated width drives the whole transition: the pane grows from the
  // right edge and whatever sits beside it (flex: 1) shrinks in the same frame,
  // so nothing trails. The content keeps its full width and is revealed, not
  // squeezed. The last preview stays mounted until the slide-out finishes.
  const [shown, setShown] = useState<PreviewRef | null>(preview);
  if (preview && (preview.kind !== shown?.kind || preview.id !== shown?.id)) setShown(preview);
  const open = useSharedValue(preview ? 1 : 0);
  useEffect(() => {
    open.set(
      withTiming(preview ? 1 : 0, { duration: preview ? 280 : 220, easing: Easing.out(Easing.cubic) }, (done) => {
        if (done && !preview) runOnJS(setShown)(null);
      }),
    );
  }, [preview, open]);
  // Always an explicit width — never toggle style keys: Reanimated keeps the
  // last value of a key that disappears, so a folded `flex: 1` survived
  // unfolding and squeezed the chat. Folded, the pane is the whole window.
  // Both dimensions are always set (see above): beside the body the pane animates
  // its width, stacked above it its height.
  const stackedH = stackedHeight ?? 0;
  const stacked = stackedHeight != null;
  // Collapsing eases the frame shut over the (full-size, clipped) content, so the
  // screen's body grows into the freed room in step.
  const collapse = useSharedValue(stackedCollapsed ? 1 : 0);
  useEffect(() => {
    collapse.set(withTiming(stackedCollapsed ? 1 : 0, { duration: 240, easing: Easing.out(Easing.cubic) }));
  }, [stackedCollapsed, collapse]);
  const frame = useAnimatedStyle(() => ({
    width: stacked || fill ? width : open.get() * paneW.get(),
    height: stacked ? open.get() * stackedH * (1 - collapse.get()) : "100%",
  }));

  // Folded (fill) there is nothing to slide beside: closing just removes it,
  // instead of a half-width slide-out over the chat.
  if (!shown || (fill && !preview)) return null;
  const close = { key: "close", label: "Close preview", icon: "xmark" as const, onPress: onClose };

  return (
    <Animated.View style={[{ overflow: "hidden" }, frame]}>
      <Host style={fill ? { flex: 1 } : stacked ? { width, height: stackedH } : { width: paneWidth, flex: 1 }}>
        <NavigationStack modifiers={[onHingeChange((_, next) => setHinge(rememberHingeStatus(next.hinge?.status ?? null)))]}>
          {shown.kind === "note" ? (
            <ChromeColumn key={`note:${shown.id}`} leading={[close]} slot="secondary">
              <NoteDetailScreen nested noteId={shown.id} onClose={onClose} />
            </ChromeColumn>
          ) : shown.kind === "card" ? (
            <ChromeColumn key={`card:${shown.id}`} leading={[close]} slot="secondary">
              <CardDetailScreen cardId={shown.id} onClose={onClose} onChanged={onChanged} />
            </ChromeColumn>
          ) : (
            // A project peek: Overview only (no section switcher — fixing `view`
            // hides it). Its note/task rows open in this same pane, and the
            // Overview's "View board" / "Open notes" shortcuts hand the project to
            // the Projects tab, which has the full tree | view | item layout.
            <ChromeColumn key={`project:${shown.id}`} leading={[close]} slot="secondary">
              <ProjectScreen
                nested
                projectId={shown.id}
                view="overview"
                onSelectView={(next) => {
                  showProjectInSplitView(shown.id, next);
                  onClose();
                  router.navigate("/projects");
                }}
                onOpenNote={onOpen ? (id) => onOpen({ kind: "note", id }) : undefined}
                onOpenCard={onOpen ? (id) => onOpen({ kind: "card", id }) : undefined}
              />
            </ChromeColumn>
          )}
        </NavigationStack>
      </Host>
    </Animated.View>
  );
}
