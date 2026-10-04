import type { ComponentType } from "react";
import RNSegmentedControl, { type SegmentedControlProps } from "@react-native-segmented-control/segmented-control";

/**
 * The native segmented control, typed for the React Native Strict TypeScript
 * API. The library's own class typing (2.5.7, the latest) mixes in
 * `NativeMethods`, which the strict API no longer exports, so the default
 * export can't be used as a JSX component. Drop this once the library ships
 * strict-API types.
 */
export const SegmentedControl = RNSegmentedControl as unknown as ComponentType<SegmentedControlProps>;
export type { SegmentedControlProps };
