import { useRouter } from "expo-router";
import { useTheme } from "@/theme";
import { useSyncStatus } from "@/sync/useSyncStatus";
import { ICON_ICLOUD, ICON_ICLOUD_OFF, ICON_ICLOUD_SYNC, type ToolbarIcon } from "@/components/toolbar-icons";

/**
 * Derives the props for a native sync-status toolbar button from the auto-sync
 * controller's live state, as an iCloud SF Symbol (so it matches the other
 * native header buttons — a lucide SVG looked out of place among them).
 *
 * Returned as a hook (not a wrapper component) because `Stack.Toolbar` reads its
 * DIRECT children's element types to build native header items; a wrapper whose
 * *return value* is a `Stack.Toolbar.Button` isn't recognised and renders
 * nothing. Callers spread/apply these onto an inline `<Stack.Toolbar.Button>`.
 *
 * State → glyph: idle/synced → icloud · offline → icloud.slash · syncing OR
 * pending changes → arrow.triangle.2.circlepath.icloud. Tint escalates
 * (warning when pending, muted when offline). Tapping opens the Sync modal.
 */
export function useSyncBadge(): {
  icon: ToolbarIcon;
  tintColor: string;
  accessibilityLabel: string;
  accessibilityHint: string;
  onPress: () => void;
} {
  const t = useTheme();
  const router = useRouter();
  const { state, pending } = useSyncStatus();

  const offline = state === "offline";
  const active = state === "syncing" || pending > 0;

  return {
    icon: offline ? ICON_ICLOUD_OFF : active ? ICON_ICLOUD_SYNC : ICON_ICLOUD,
    tintColor: offline ? t.textTertiary : pending > 0 ? t.warning : t.success,
    accessibilityLabel: "Sync status",
    accessibilityHint: "Opens sync details",
    onPress: () => router.push("/sync"),
  };
}
