import { createContext, useContext, useState } from "react";
import { useWindowDimensions } from "react-native";
import { Host } from "@expo/ui";
import { NavigationStack } from "@expo/ui/swift-ui";
import { onHingeChange, type HingeStatus } from "@expo/ui/swift-ui/modifiers";
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

export function ChatPreviewPane({ preview, onClose }: { preview: PreviewRef; onClose: () => void }) {
  const { width } = useWindowDimensions();
  const [hinge, setHinge] = useState<HingeStatus | null>(null);
  // Half open: the pane takes the right page exactly. Flat: a little under half,
  // leaving the conversation the larger share.
  const paneWidth = hinge === "partiallyOpen" ? width / 2 : Math.round(width * 0.46);

  const close = { key: "close", label: "Close preview", icon: "xmark" as const, onPress: onClose };

  return (
    <Host style={{ width: paneWidth }}>
      <NavigationStack modifiers={[onHingeChange((_, next) => setHinge(next.hinge?.status ?? null))]}>
        {preview.kind === "note" ? (
          <ChromeColumn key={`note:${preview.id}`} leading={[close]}>
            <NoteDetailScreen nested noteId={preview.id} onClose={onClose} />
          </ChromeColumn>
        ) : (
          <ChromeColumn key={`card:${preview.id}`} leading={[close]}>
            <CardDetailScreen cardId={preview.id} onClose={onClose} />
          </ChromeColumn>
        )}
      </NavigationStack>
    </Host>
  );
}
