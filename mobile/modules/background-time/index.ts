import { NativeModule, requireOptionalNativeModule } from "expo";

declare class BackgroundTimeNativeModule extends NativeModule {
  /** Ask iOS for background running time; returns a token, or 0 when refused. */
  begin(name: string): number;
  /** Release the time a `begin` token holds (no-op for 0 or an expired token). */
  end(token: number): void;
  /** Seconds the app may still run in the background. */
  remainingTime(): number;
}

/**
 * The native module, or null when the build doesn't include it (Expo Go, web,
 * Android). Callers then run without the extra time.
 */
export const BackgroundTime = requireOptionalNativeModule<BackgroundTimeNativeModule>("BackgroundTime");

/**
 * Run `work`, keeping the app awake in the background until it settles. Call it
 * synchronously from the background transition: the time is requested before
 * the first await.
 */
export async function withBackgroundTime<T>(name: string, work: () => Promise<T>): Promise<T> {
  const token = BackgroundTime?.begin(name) ?? 0;
  try {
    return await work();
  } finally {
    if (token) BackgroundTime?.end(token);
  }
}
