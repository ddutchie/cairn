import { createContext, useContext, useEffect, useState } from "react";
import { useWindowDimensions } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Host } from "@expo/ui";
import { NavigationStack } from "@expo/ui/swift-ui";
import { onHingeChange, type HingeStatus } from "@expo/ui/swift-ui/modifiers";
import { lastHingeStatus, rememberHingeStatus } from "@/lib/hinge";
import { ChromeColumn } from "@/components/screen-chrome";
import { NoteDetailScreen } from "@/screens/NoteDetailScreen";
import { CardDetailScreen } from "@/screens/CardDetailScreen";

/**
 * Chat preview — on wide windows (unfolded iPhone Duo, iPad) a note or task the
 * assistant touched opens in a column beside the conversation instead of
 * navigating away, like the desktop's full-screen chat. Half open on a Duo, the
 * chat and the preview sit on either side of the hinge.
 */

export interface PreviewRef {
  kind: "note" | "card";
  id: string;
}

/** Opens a ref in the preview column; null when there's no room for one. */
const ChatPreviewContext = createContext<((ref: PreviewRef) => void) | null>(null);
export const ChatPreviewProvider = ChatPreviewContext.Provider;
export function useChatPreview() {
  return useContext(ChatPreviewContext);
}

/** Below this width the chat stays single-column and chips navigate as before. */
export const CHAT_PREVIEW_MIN_WIDTH = 700;


export function ChatPreviewPane({
  preview,
  onClose,
  onChanged,
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
  const frame = useAnimatedStyle(() => (fill ? { flex: 1 } : { width: open.get() * paneW.get() }));

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
          ) : (
            <ChromeColumn key={`card:${shown.id}`} leading={[close]} slot="secondary">
              <CardDetailScreen cardId={shown.id} onClose={onClose} onChanged={onChanged} />
            </ChromeColumn>
          )}
        </NavigationStack>
      </Host>
    </Animated.View>
  );
}
