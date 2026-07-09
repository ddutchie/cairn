import { type ReactNode } from "react";
import { Platform } from "react-native";
import { Host, ContextMenu } from "@expo/ui/swift-ui";

/**
 * Reusable native long-press context menu. Wraps arbitrary React Native content
 * (`children`) as the trigger, and shows `items` (`@expo/ui/swift-ui` Button /
 * Section / Divider / nested Menu) on long-press — the iOS-native contextual
 * menu, with the row's normal tap still passing through to the underlying
 * Pressable.
 *
 * iOS only: on other platforms it renders the trigger content unchanged (no
 * menu), so callers keep working and can offer actions elsewhere if needed.
 *
 * Example:
 *   <ContextMenuWrapper
 *     items={<>
 *       <Button label="Rename" systemImage="pencil" onPress={rename} />
 *       <Button label="Delete" systemImage="trash" role="destructive" onPress={del} />
 *     </>}
 *   >
 *     <MyRow />
 *   </ContextMenuWrapper>
 */
export function ContextMenuWrapper({
  children,
  items,
}: {
  /** The always-visible trigger content (a normal RN view/row). */
  children: ReactNode;
  /** Menu items shown on long-press. */
  items: ReactNode;
}) {
  if (Platform.OS !== "ios") return <>{children}</>;

  return (
    <Host matchContents>
      <ContextMenu>
        <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
        <ContextMenu.Items>{items}</ContextMenu.Items>
      </ContextMenu>
    </Host>
  );
}
