/**
 * iCloud container access for the mobile sync folder — no picker, auto-persists.
 *
 * The app has its own iCloud ubiquity container (entitlement added by
 * plugins/withICloudContainer). Its Documents folder is always accessible to
 * the app with no security-scoped-bookmark dance, and iOS keeps it in sync
 * across the user's devices. We put the oplog files under Documents/ so they
 * surface in iCloud Drive under the "Cairn" app folder — the same place the
 * desktop points its Device Sync at.
 *
 * (Replaces the old Directory.pickDirectoryAsync approach, whose access did NOT
 * survive app relaunch → "you don't have permission" on write.)
 */

import { defaultICloudContainerPath, isICloudAvailable, createDir, exist, PathUtils } from "react-native-cloud-store";

/** Subfolder inside the container's Documents where oplogs live. */
const SYNC_SUBDIR = "sync";

export async function iCloudAvailable(): Promise<boolean> {
  try {
    return await isICloudAvailable();
  } catch {
    return false;
  }
}

/**
 * Absolute path to the sync folder inside the app's iCloud container Documents,
 * creating it if needed. Returns null if iCloud isn't available (not signed in).
 */
export async function getSyncFolderPath(): Promise<string | null> {
  const container = defaultICloudContainerPath;
  if (!container) return null;
  const docs = PathUtils.join(container, "Documents");
  const dir = PathUtils.join(docs, SYNC_SUBDIR);
  try {
    if (!(await exist(dir))) await createDir(dir);
  } catch {
    // createDir throws if it already exists in some cases — ignore.
  }
  return dir;
}

/** Human label for the connected folder (for the UI). */
export function syncFolderLabel(): string {
  return "iCloud Drive › Cairn › sync";
}
