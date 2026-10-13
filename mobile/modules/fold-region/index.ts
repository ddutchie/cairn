import { NativeModule, requireOptionalNativeModule } from "expo";

/** `[x, y, width, height]` in window points. */
export type RegionFrame = [number, number, number, number];

export interface DivisionRegionPayload {
  /** False when the OS/SDK has no `reservedRegions` API (iOS < 27.1). */
  supported: boolean;
  /** The active division region (incl. margins), or null when there is none. */
  frame: RegionFrame | null;
}

declare class FoldRegionNativeModule extends NativeModule<{
  onDivisionRegionChange: (event: DivisionRegionPayload) => void;
}> {
  /** Synchronous read of the current scene's active division region. */
  getDivisionRegion(): DivisionRegionPayload;
}

/**
 * The native module, or null when the build doesn't include it (Expo Go, web,
 * Android). Callers fall back to the inferred crease (`src/lib/fold.ts`).
 */
export const FoldRegion = requireOptionalNativeModule<FoldRegionNativeModule>("FoldRegion");
