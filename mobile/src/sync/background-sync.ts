/**
 * Periodic catch-up sync while the app isn't open (expo-background-task, iOS
 * BGTaskScheduler).
 *
 * The background flush in controller.ts covers a write made just before the
 * user switches away. This covers what it can't: a sync iOS cut short anyway,
 * and peer edits that landed since, so the widgets and the next launch start
 * fresh. iOS decides when it runs (often overnight or while charging);
 * `minimumInterval` is only a floor.
 *
 * `defineTask` has to run at module load, before React mounts, because iOS can
 * launch the app in the background just to run the task. The root layout
 * imports this module for that side effect.
 */

import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { initDatabase, getActiveSource } from "@/db";
import { isDemoSource } from "@/dev/demo-seed";
import { refreshWidgets } from "@/widgets";
import { getSnapshot, requestSync } from "./controller";

export const BACKGROUND_SYNC_TASK = "cairn-background-sync";

/** Minutes between runs, at the least. iOS treats it as a hint. */
const MINIMUM_INTERVAL_MIN = 30;

/** One background run: open the DB, sync the active source, refresh widgets. */
export async function runBackgroundSync(): Promise<BackgroundTask.BackgroundTaskResult> {
  try {
    if (!initDatabase().hasSource) return BackgroundTask.BackgroundTaskResult.Success;
    if (isDemoSource(getActiveSource())) return BackgroundTask.BackgroundTaskResult.Success;
    // Through the controller, so it can't overlap a foreground sync.
    // The controller swallows sync errors into the snapshot (state "offline",
    // which also covers an unreachable folder), so read the outcome from there.
    await requestSync("background-task");
    const { state, lastResult: res } = getSnapshot();
    if (state === "offline") return BackgroundTask.BackgroundTaskResult.Failed;
    if (res?.connected && res.peerOpsApplied > 0) refreshWidgets();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    console.warn("[sync] background task failed:", e);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
}

TaskManager.defineTask(BACKGROUND_SYNC_TASK, runBackgroundSync);

/**
 * Schedule the task (idempotent; call once a source is selected). A no-op when
 * background tasks are unavailable: Expo Go, the Simulator, or Background App
 * Refresh turned off.
 */
export async function registerBackgroundSync(): Promise<void> {
  try {
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return;
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) return;
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, { minimumInterval: MINIMUM_INTERVAL_MIN });
  } catch (e) {
    console.warn("[sync] couldn't schedule background sync:", e);
  }
}
