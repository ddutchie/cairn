import { useCallback, useState } from "react";
import { Stack, useFocusEffect } from "expo-router";
import { getActiveSource } from "@/db";
import { switchSource } from "@/sync/controller";
import { useSyncSources } from "@/sync/useSyncSources";
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

  return (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Menu
        icon={ICON_CAIRN}
        iconRenderingMode="template"
        accessibilityLabel="Switch workspace"
      >
        {sources.map((s) => (
          <Stack.Toolbar.MenuAction
            key={s.workspaceId}
            isOn={s.workspaceId === active}
            onPress={() => onSwitch(s.workspaceId)}
          >
            {s.name ?? "Workspace"}
          </Stack.Toolbar.MenuAction>
        ))}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  );
}
