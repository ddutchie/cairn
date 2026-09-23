/**
 * Updater-initiated quit flag.
 *
 * Two flows quit the app to install an update — the boot-sequence update
 * installer (`electron/splash/boot-sequence.ts`) and the in-app "install"
 * button (`updater:install` in `electron/ipc/handlers.ts`) — both via
 * electron-updater's `quitAndInstall()`, which stages the install and then
 * quits. main.ts's `before-quit` gate must NOT intercept those quits with
 * `preventDefault()`: the install is already staged and vetoing the quit can
 * strand it. Those call sites set this flag first; `before-quit` then takes
 * the fast path (sync teardown only, no async wait).
 *
 * The passive `autoInstallOnAppQuit` path needs no flag: electron-updater
 * hooks the later `quit` event there, so the normal async gate runs first
 * and the install proceeds on the re-quit.
 */

let updaterQuitRequested = false;

/** Mark that the upcoming quit belongs to an explicit update install. */
export function markUpdaterQuitRequested(): void {
  updaterQuitRequested = true;
}

/** Whether the current quit was initiated to install an update. */
export function isUpdaterQuitRequested(): boolean {
  return updaterQuitRequested;
}
