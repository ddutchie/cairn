import { createContext, useContext, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { LinearTransition, SlideInRight, SlideOutRight } from "react-native-reanimated";
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
}: {
  preview: PreviewRef;
  onClose: () => void;
  /** The previewed task was saved, archived or deleted. */
  onChanged?: () => void;
}) {
  const { width } = useWindowDimensions();
  const { right } = useSafeAreaInsets();
  const [hinge, setHinge] = useState<HingeStatus | null>(lastHingeStatus);
  // On a device with a hinge (iPhone Duo, folded flat or half open) the pane
  // starts exactly on the fold and runs to the side rail, so neither the chat
  // nor the preview ever crosses the crease. Without one (iPad) it takes a
  // little under half, leaving the conversation the larger share.
  const hasHinge = hinge != null && hinge !== "closed";
  const paneWidth = hasHinge ? width / 2 - right : Math.round(width * 0.46);

  const close = { key: "close", label: "Close preview", icon: "xmark" as const, onPress: onClose };

  // Slides in from the right edge and back out on close; the content beside it
  // reflows with a LinearTransition (see PREVIEW_LAYOUT).
  return (
    <Animated.View entering={SlideInRight.duration(280)} exiting={SlideOutRight.duration(220)} style={{ width: paneWidth }}>
    <Host style={{ flex: 1 }}>
      <NavigationStack modifiers={[onHingeChange((_, next) => setHinge(rememberHingeStatus(next.hinge?.status ?? null)))]}>
        {preview.kind === "note" ? (
          <ChromeColumn key={`note:${preview.id}`} leading={[close]}>
            <NoteDetailScreen nested noteId={preview.id} onClose={onClose} />
          </ChromeColumn>
        ) : (
          <ChromeColumn key={`card:${preview.id}`} leading={[close]}>
            <CardDetailScreen cardId={preview.id} onClose={onClose} onChanged={onChanged} />
          </ChromeColumn>
        )}
      </NavigationStack>
    </Host>
    </Animated.View>
  );
}

/** Layout transition for whatever sits beside the pane, so it narrows smoothly. */
export const PREVIEW_LAYOUT = LinearTransition.duration(280);
