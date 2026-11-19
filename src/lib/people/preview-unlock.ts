/** This device's "preview features" unlock (docs/plans/people-layer.md): localStorage only, never synced. */
const KEY = "cairn:preview-features-unlocked";

export function isPreviewUnlocked(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setPreviewUnlocked(): void {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // private mode or blocked storage: the unlock lasts until reload
  }
}
