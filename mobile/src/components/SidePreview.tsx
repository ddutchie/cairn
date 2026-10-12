import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View, useWindowDimensions, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Host } from "@expo/ui";
import { NavigationStack } from "@expo/ui/swift-ui";
import { onHingeChange, type HingeStatus } from "@expo/ui/swift-ui/modifiers";
import { lastHingeStatus, rememberHingeStatus } from "@/lib/hinge";
// NOTE (SDK 58): useHeaderHeight has no public expo-router export (see app/picker/due-date.tsx).
import { useHeaderHeight } from "expo-router/build/react-navigation/elements/index";
import { useTheme } from "@/theme";
import { ChromeColumn } from "@/components/screen-chrome";
import { NoteDetailScreen } from "@/screens/NoteDetailScreen";
import { CardDetailScreen } from "@/screens/CardDetailScreen";
import { ProjectScreen } from "@/screens/ProjectScreen";

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
export function useSidePreview({ title }: { title: string }): SidePreviewState {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const headerHeight = useHeaderHeight();
  const [preview, setPreview] = useState<PreviewRef | null>(null);
  const wide = SIDE_PREVIEW_SUPPORTED && width >= SIDE_PREVIEW_MIN_WIDTH;
  const fills = SIDE_PREVIEW_SUPPORTED && !wide && preview != null;
  const screenOptions: Record<string, unknown> = {
    headerShown: !fills,
    // While a preview is open its SwiftUI pane reaches the window edge and
    // handles the side rail itself; the RN padding would double that inset.
    contentStyle:
      preview != null
        ? { backgroundColor: t.background, paddingLeft: insets.left }
        : { backgroundColor: t.background, paddingLeft: insets.left, paddingRight: insets.right },
    title: wide ? "" : title,
    headerTransparent: wide,
    // TabStack paints the header with the surface colour, and iOS 26 adds a
    // scroll-edge fade under it — both drew a white strip across the top.
    ...(wide
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
    fills,
    showToolbar: preview == null,
    screenOptions,
    contentPaddingTop: wide ? headerHeight : 0,
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
}: {
  state: SidePreviewState;
  children: ReactNode;
  /** Extra style for the body column (e.g. background, top padding). */
  bodyStyle?: ViewStyle | ViewStyle[];
  /** The previewed task was saved, archived or deleted. */
  onChanged?: () => void;
}) {
  const { preview, setPreview, fills, contentPaddingTop } = state;
  return (
    <SidePreviewProvider value={SIDE_PREVIEW_SUPPORTED ? setPreview : null}>
      <View style={styles.row}>
        <View style={[{ flex: 1, paddingTop: contentPaddingTop }, bodyStyle, fills && styles.collapsed]}>{children}</View>
        {SIDE_PREVIEW_SUPPORTED && (
          <SidePreviewPane
            preview={preview}
            fill={!state.wide}
            onClose={() => setPreview(null)}
            onChanged={onChanged}
            onOpen={setPreview}
          />
        )}
      </View>
    </SidePreviewProvider>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row", overflow: "hidden" },
  collapsed: { flex: 0, width: 0, overflow: "hidden" },
});

export function SidePreviewPane({
  preview,
  onClose,
  onChanged,
  onOpen,
  fill = false,
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
  onClose: () => void;
  /** The previewed task was saved, archived or deleted. */
  onChanged?: () => void;
  /** Swap the pane's content (a project's note/task row opens in place of the project). */
  onOpen?: (ref: PreviewRef) => void;
}) {
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
  const frame = useAnimatedStyle(() => ({ width: fill ? width : open.get() * paneW.get() }));

  // Folded (fill) there is nothing to slide beside: closing just removes it,
  // instead of a half-width slide-out over the chat.
  if (!shown || (fill && !preview)) return null;
  const close = { key: "close", label: "Close preview", icon: "xmark" as const, onPress: onClose };

  return (
    <Animated.View style={[{ overflow: "hidden" }, frame]}>
      <Host style={fill ? { flex: 1 } : { width: paneWidth, flex: 1 }}>
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
            // A whole project: its own Overview / Notes / Board switcher. Its
            // note/task rows open in this same pane instead of pushing a route.
            <ChromeColumn key={`project:${shown.id}`} leading={[close]} slot="secondary">
              <ProjectScreen
                nested
                projectId={shown.id}
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
