import { Image } from "expo-image";
import { StyleSheet } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { COMPOSER, COMPOSER_STRIP_HEIGHT, GRID, GUTTER, mix, type Frame } from "./constants";
import type { LibraryPhoto } from "./use-photo-library";

export interface Flight {
  photo: LibraryPhoto;
  from: Frame;
  slot: number;
  fromRadius?: number;
}

function FlyingPhoto({
  flight,
  screenWidth,
  attach,
  strip,
  composerBottom,
}: {
  flight: Flight;
  screenWidth: number;
  attach: SharedValue<number>;
  strip: SharedValue<number>;
  composerBottom: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const a = attach.get();
    const composerTop = composerBottom.get() - COMPOSER.rowHeight - strip.get() * COMPOSER_STRIP_HEIGHT;
    const step = COMPOSER.thumbSize + COMPOSER.thumbGap;
    const lastVisible = screenWidth - GUTTER - COMPOSER.stripPaddingTop - COMPOSER.thumbSize;
    const toX = Math.min(GUTTER + COMPOSER.stripPaddingTop + flight.slot * step, lastVisible);
    const toY = composerTop + COMPOSER.stripPaddingTop;
    return {
      left: mix(a, flight.from.x, toX),
      top: mix(a, flight.from.y, toY),
      width: mix(a, flight.from.w, COMPOSER.thumbSize),
      height: mix(a, flight.from.h, COMPOSER.thumbSize),
      borderRadius: mix(a, flight.fromRadius ?? GRID.cellRadius, COMPOSER.thumbRadius),
    };
  });

  return (
    <Animated.View pointerEvents="none" style={[styles.photo, style]}>
      <Image source={flight.photo.id} recyclingKey={flight.photo.id} contentFit="cover" cachePolicy="memory-disk" priority="high" transition={0} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

export function AttachmentFlight({
  flights,
  screenWidth,
  attach,
  strip,
  composerBottom,
}: {
  flights: Flight[];
  screenWidth: number;
  attach: SharedValue<number>;
  strip: SharedValue<number>;
  composerBottom: SharedValue<number>;
}) {
  if (!flights.length) return null;
  return (
    <>
      {flights.map((flight) => (
        <FlyingPhoto key={flight.photo.id} flight={flight} screenWidth={screenWidth} attach={attach} strip={strip} composerBottom={composerBottom} />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  photo: { position: "absolute", overflow: "hidden", borderCurve: "continuous", backgroundColor: "#141414" },
});
