import { useCallback, useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as Updates from "expo-updates";

/**
 * Over-the-air update coordination via EAS Update / expo-updates.
 *
 * Checks for a new update on cold launch and whenever the app returns to the
 * foreground, downloads it in the background, and exposes whether one is ready
 * to apply (`isUpdatePending`). The UI shows a banner and calls `reload()` when
 * the user opts in — we never force a relaunch mid-use.
 *
 * No-ops in development (Updates.isEnabled is false in Expo Go / dev client and
 * when running from Metro), so it only does real work in release/EAS builds.
 */
export function useAppUpdates() {
  const { isUpdatePending, isDownloading, isChecking } = Updates.useUpdates();

  const checkAndDownload = useCallback(async () => {
    if (!Updates.isEnabled) return;
    try {
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable) {
        // Download in the background; useUpdates() flips isUpdatePending to true
        // once it's staged and ready to apply on the next reload.
        await Updates.fetchUpdateAsync();
      }
    } catch {
      // Offline / server error — ignore; we'll try again next launch/resume.
    }
  }, []);

  // Check on mount (cold launch) and whenever the app becomes active again.
  useEffect(() => {
    checkAndDownload();
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") checkAndDownload();
    });
    return () => sub.remove();
  }, [checkAndDownload]);

  const reload = useCallback(async () => {
    try {
      await Updates.reloadAsync();
    } catch {
      // If reload fails the update still applies on the next natural launch.
    }
  }, []);

  return { isUpdatePending, isDownloading, isChecking, reload };
}
