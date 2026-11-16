/**
 * Platform accessor for the renderer. `window.electron.platform` is a plain
 * string on the bridge (`"darwin" | "win32" | "linux"`), not a channel — this
 * keeps the single allowed `window.electron` touchpoint inside `src/lib/ipc/`.
 * `undefined` off-Electron (callers treat non-`"win32"` as POSIX).
 */
export function platformName(): "darwin" | "win32" | "linux" | undefined {
  if (typeof window === "undefined") return undefined;
  return window.electron?.platform;
}

/** True on Windows (backslashes, drive letters, `\\?\` prefixes). */
export function isWindows(): boolean {
  return platformName() === "win32";
}
