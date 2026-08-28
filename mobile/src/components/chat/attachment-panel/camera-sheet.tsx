import { CameraView, useCameraPermissions, type CameraType, type FlashMode } from "expo-camera";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { CAMERA, COLORS } from "./constants";

export interface CameraSheetHandle {
  takePicture: () => Promise<string | null>;
}

export const CameraSheet = forwardRef<CameraSheetHandle, { width: number; height: number; facing: CameraType; flash: FlashMode; lifting: boolean }>(
  function CameraSheet({ width, height, facing, flash, lifting }, handle) {
    const cameraRef = useRef<CameraView>(null);
    const [permission, requestPermission] = useCameraPermissions();
    const ready = useRef(false);

    useEffect(() => {
      if (permission && !permission.granted && permission.canAskAgain) requestPermission();
    }, [permission, requestPermission]);

    useImperativeHandle(
      handle,
      () => ({
        takePicture: async () => {
          const camera = cameraRef.current;
          if (!camera || !ready.current) return null;
          try {
            const picture = await camera.takePictureAsync({ quality: CAMERA.quality, shutterSound: false });
            return picture?.uri ?? null;
          } catch {
            return null;
          }
        },
      }),
      [],
    );

    const granted = !!permission?.granted;

    return (
      <View style={[styles.root, { width, height }]}>
        {granted ? (
          <CameraView ref={cameraRef} facing={facing} flash={flash} mirror={facing === "front"} animateShutter={false} onCameraReady={() => (ready.current = true)} style={[StyleSheet.absoluteFill, lifting && styles.lifted]} />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>
              {permission && !permission.canAskAgain ? "Camera access is off. Turn it on in Settings to try this demo." : "Waiting for camera access…"}
            </Text>
          </View>
        )}
      </View>
    );
  },
);

const styles = StyleSheet.create({
  root: { position: "absolute", left: 0, top: 0, backgroundColor: COLORS.background },
  lifted: { opacity: 0 },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 48 },
  placeholderText: { color: COLORS.placeholder, fontSize: 15, textAlign: "center" },
});
