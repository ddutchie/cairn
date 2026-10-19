import { useCallback, useState } from "react";
import { Platform } from "react-native";
import { Stack, useFocusEffect } from "expo-router";
import { getActiveSource } from "@/db";
import { switchSource } from "@/sync/controller";
import { useSyncSources } from "@/sync/useSyncSources";
import { Button, Host, Menu, RNHostView, Section } from "@expo/ui/swift-ui";
import { SyncRingLogo } from "@/components/SyncRingLogo";
import { useSyncBadge } from "@/components/SyncStatusBadge";
import { ICON_CAIRN } from "@/components/toolbar-icons";

/**
 * Header-LEFT workspace switcher, rendered as a native `Stack.Toolbar.Menu`.
 *
 * Emits a `Stack.Toolbar placement="left"` so it lives in the leading header
 * slot and renders as a true native (Liquid Glass) menu button. It is
 * ICON-ONLY (the Cairn logo) — no `Stack.Toolbar.Label` and no `title` prop, so
 * the item never flickers between the icon and a text label (the native item's
 * `title` can otherwise bleed into the header title slot on some renders); the
 * active workspace name shows as the screen's centered header title instead.
 * Tapping lists the workspaces discovered in the shared folder with a checkmark
 * on the active one. This replaces the earlier custom `GlassMenu`-in-
 * `headerTitle` approach, which the native centered title slot sized/positioned
 * unreliably.
 *
 * Discovery re-runs on focus (`useFocusEffect`); sync itself never scans for new
 * workspaces (it only round-trips the active source), so focusing this surface
 * is how a newly-published desktop workspace shows up.
 *
 * Mount this inside the screen body alongside `<Stack.Screen>` (it returns a
 * `Stack.Toolbar`, NOT a title component).
 */
export function WorkspaceHeaderMenu() {
  // `active` is tracked locally so the checkmark updates the instant the user
  // switches, before the next folder scan. `sources` (merged with the active
  // workspace and name-sorted) + `refresh` come from the shared hook.
  const [active, setActive] = useState<string | null>(() => getActiveSource());
  const { sources, refresh } = useSyncSources({ mergeActive: true });

  useFocusEffect(
    useCallback(() => {
      setActive(getActiveSource());
      void refresh();
    }, [refresh]),
  );

  const onSwitch = (ws: string) => {
    if (ws === active) return;
    switchSource(ws);
    setActive(ws);
  };

  const sync = useSyncBadge();

  return (
    <Stack.Toolbar placement="left">
      <WorkspaceMenuItems active={active} sources={sources} onSwitch={onSwitch} sync={sync} />
    </Stack.Toolbar>
  );
}

/**
 * The workspace-switcher menu itself, without the Toolbar wrapper — for
 * embedding inside another `Stack.Toolbar` (the Projects split view's native
 * header carries it alongside bridged column items when the Duo side rail
 * would otherwise swallow the sidebar's own buttons).
 */
export function WorkspaceMenuItems({
  active,
  sources,
  onSwitch,
  sync,
}: {
  active: string | null;
  sources: { workspaceId: string; name?: string | null }[];
  onSwitch: (ws: string) => void;
  /** Sync state + opener, folded into this menu (replaces the separate sync button). */
  sync?: Pick<ReturnType<typeof useSyncBadge>, "icon" | "tintColor" | "statusText" | "attention" | "onPress">;
}) {
  // Android has no SwiftUI: use the cross-platform native toolbar menu (a static
  // logo, tinted when sync needs attention).
  if (Platform.OS !== "ios") {
    return (
      <Stack.Toolbar.Menu
        icon={ICON_CAIRN}
        iconRenderingMode="template"
        tintColor={sync?.attention ? sync.tintColor : undefined}
        accessibilityLabel={sync ? `Switch workspace. Sync: ${sync.statusText}` : "Switch workspace"}
      >
        <Stack.Toolbar.Menu inline title="Workspace">
          {sources.map((s) => (
            <Stack.Toolbar.MenuAction key={s.workspaceId} isOn={s.workspaceId === active} onPress={() => onSwitch(s.workspaceId)}>
              {s.name ?? "Workspace"}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
        {sync ? (
          <Stack.Toolbar.Menu inline title="Sync">
            <Stack.Toolbar.MenuAction icon={sync.icon} onPress={sync.onPress}>
              {`Sync · ${sync.statusText}`}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        ) : null}
      </Stack.Toolbar.Menu>
    );
  }

  // iOS: a SwiftUI menu (not Stack.Toolbar.Menu) so the label can be the logo with the
  // sync ring drawn around it; the native toolbar menu only takes a static icon.
  return (
    <Stack.Toolbar.View>
      <Host matchContents>
        <Menu
          label={
            <RNHostView matchContents>
              <SyncRingLogo />
            </RNHostView>
          }
        >
          <Section title="Workspace">
            {sources.map((s) => (
              <Button
                key={s.workspaceId}
                label={s.name ?? "Workspace"}
                systemImage={s.workspaceId === active ? "checkmark" : undefined}
                onPress={() => onSwitch(s.workspaceId)}
              />
            ))}
          </Section>
          {sync ? (
            <Section title="Sync">
              <Button
                label={`Sync · ${sync.statusText}`}
                systemImage="arrow.triangle.2.circlepath"
                onPress={sync.onPress}
              />
            </Section>
          ) : null}
        </Menu>
      </Host>
    </Stack.Toolbar.View>
  );
}
