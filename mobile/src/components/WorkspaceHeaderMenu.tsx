import { useCallback, useState } from "react";
import { Stack, useFocusEffect } from "expo-router";
import { getActiveSource, getActiveSourceName, getDeviceId } from "@/db";
import { getSyncFolderPath } from "@/sync/folder";
import { listSources, type SyncSource } from "@/sync/fs-transport";
import { switchSource } from "@/sync/controller";
import { ICON_WORKSPACE } from "@/components/toolbar-icons";

/**
 * Header-LEFT workspace switcher, rendered as a native `Stack.Toolbar.Menu`.
 *
 * Emits a `Stack.Toolbar placement="left"` so it lives in the leading header
 * slot and renders as a true native (Liquid Glass) menu button — the active
 * workspace name is the button `label`, and tapping lists the workspaces
 * discovered in the shared folder with a checkmark on the active one. This
 * replaces the earlier custom `GlassMenu`-in-`headerTitle` approach, which the
 * native centered title slot sized/positioned unreliably.
 *
 * Discovery re-runs on focus (`useFocusEffect`); sync itself never scans for new
 * workspaces (it only round-trips the active source), so focusing this surface
 * is how a newly-published desktop workspace shows up.
 *
 * Mount this inside the screen body alongside `<Stack.Screen>` (it returns a
 * `Stack.Toolbar`, NOT a title component).
 */
export function WorkspaceHeaderMenu() {
  const [active, setActive] = useState<string | null>(() => getActiveSource());
  const [name, setName] = useState<string | null>(() => getActiveSourceName());
  const [sources, setSources] = useState<SyncSource[]>([]);

  const refresh = useCallback(() => {
    setActive(getActiveSource());
    setName(getActiveSourceName());
    void (async () => {
      try {
        const folder = await getSyncFolderPath();
        if (!folder) return;
        setSources(await listSources(folder, getDeviceId()));
      } catch {
        /* keep previous list */
      }
    })();
  }, []);

  useFocusEffect(useCallback(() => refresh(), [refresh]));

  // Merge active (may not be in the scan yet) with discovered, keyed by id, so
  // the current workspace always appears even before the folder scan resolves.
  const byId = new Map<string, SyncSource>();
  for (const s of sources) byId.set(s.workspaceId, s);
  if (active && !byId.has(active)) byId.set(active, { workspaceId: active, name });
  const all = [...byId.values()].sort((a, b) =>
    (a.name ?? a.workspaceId).localeCompare(b.name ?? b.workspaceId),
  );

  const onSwitch = (ws: string) => {
    if (ws === active) return;
    switchSource(ws);
    setActive(ws);
    setName(getActiveSourceName());
  };

  const label = name ?? "Workspace";

  return (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Menu
        icon={ICON_WORKSPACE}
        title="Workspaces"
        accessibilityLabel="Switch workspace"
      >
        <Stack.Toolbar.Label>{label}</Stack.Toolbar.Label>
        {all.map((s) => (
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
