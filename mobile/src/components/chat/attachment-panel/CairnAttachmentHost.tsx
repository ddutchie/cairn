import type { CameraType, FlashMode } from "expo-camera";
import * as Haptics from "expo-haptics";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { KeyboardController, OverKeyboardView, useKeyboardHandler, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useDerivedValue, useSharedValue, withDelay, withSequence, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { AttachmentFlight, type Flight } from "./attachment-flight";
import { AttachmentMenu, type MenuAction } from "./attachment-menu";
import { AttachmentPanel } from "./attachment-panel";
import { CameraBar } from "./camera-bar";
import { CameraSheet, type CameraSheetHandle } from "./camera-sheet";
import { COLORS, COMPOSER, DURATION, EASE_FADE, EASE_OUT, GRID, GUTTER, MENU, MENU_HEIGHT, SPRING } from "./constants";
import { PhotoGrid, PhotoGridBar, type PhotoGridHandle } from "./photo-grid";
import { usePhotoLibrary, type LibraryPhoto } from "./use-photo-library";
import { cameraUriToAttachment, libraryPhotoToAttachment, pickFiles } from "@/chat/file-attachments";
import type { Attachment } from "@/chat/agent";

type Mode = "closed" | "menu" | "photos" | "camera";
type Sheet = "photos" | "camera";

export interface CairnAttachmentHostHandle {
  toggle: () => void;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

export interface CairnAttachmentHostProps {
  strip: SharedValue<number>;
  plusOut: SharedValue<number>;
  composerBottom: SharedValue<number>;
  existingCount: number;
  onAddAttachments: (atts: Attachment[]) => void;
  onMenuAction?: (action: MenuAction) => void;
}

export const CairnAttachmentHost = forwardRef<CairnAttachmentHostHandle, CairnAttachmentHostProps>(function CairnAttachmentHost(
  { strip, plusOut, composerBottom, existingCount, onAddAttachments, onMenuAction },
  ref,
) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { photos, status } = usePhotoLibrary();
  const gridRef = useRef<PhotoGridHandle>(null);
  const cameraRef = useRef<CameraSheetHandle>(null);
  const leadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [mode, setMode] = useState<Mode>("closed");
  const [sheet, setSheet] = useState<Sheet>("photos");
  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState<FlashMode>("off");
  const capturing = useRef(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [closing, setClosing] = useState(false);
  const [settledKeyboard, setSettledKeyboard] = useState(0);

  const open = useSharedValue(0);
  const morph = useSharedValue(0);
  const attach = useSharedValue(0);
  const menuOpacity = useSharedValue(1);
  const gridOpacity = useSharedValue(0);
  const blur = useSharedValue(0);

  useKeyboardHandler({ onEnd: (e) => { "worklet"; scheduleOnRN(setSettledKeyboard, e.height); } }, []);
  useEffect(() => () => { if (leadTimer.current) clearTimeout(leadTimer.current); }, []);

  const settledBottom = height - Math.max(settledKeyboard, insets.bottom) - COMPOSER.keyboardGap;
  const panelTop = settledBottom - COMPOSER.rowHeight / 2 + MENU.centerOffset - MENU_HEIGHT / 2;
  const gridWidth = width - GUTTER * 2;
  const gridHeight = height - panelTop - GUTTER;

  const closeSheet = useCallback(() => {
    setMode("closed");
    setClosing(false);
    KeyboardController.setFocusTo("current");
  }, []);

  const pulseBlur = useCallback(() => {
    blur.set(withSequence(withTiming(1, { duration: 60, easing: EASE_OUT }), withTiming(0, { duration: DURATION.blur, easing: EASE_FADE })));
  }, [blur]);

  const clearLead = useCallback(() => {
    if (leadTimer.current === null) return;
    clearTimeout(leadTimer.current);
    leadTimer.current = null;
  }, []);

  const openMenu = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    plusOut.set(withSpring(1, SPRING.panel));
    morph.set(0);
    attach.set(0);
    gridOpacity.set(0);
    menuOpacity.set(1);
    blur.set(1);
    clearLead();
    leadTimer.current = setTimeout(() => {
      leadTimer.current = null;
      setMode("menu");
      open.set(withSpring(1, SPRING.panel));
      blur.set(withTiming(0, { duration: DURATION.blur, easing: EASE_FADE }));
    }, DURATION.plusLead);
  }, [attach, blur, clearLead, gridOpacity, menuOpacity, morph, open, plusOut]);

  const dismiss = useCallback(() => {
    clearLead();
    setSelected([]);
    setClosing(true);
    blur.set(withTiming(1, { duration: DURATION.panel, easing: EASE_FADE }));
    morph.set(withSpring(0, SPRING.panelOut));
    menuOpacity.set(withTiming(1, { duration: DURATION.crossfade, easing: EASE_FADE }));
    gridOpacity.set(withTiming(0, { duration: DURATION.crossfade, easing: EASE_FADE }));
    open.set(withSpring(0, SPRING.panelOut, (finished) => { "worklet"; if (finished) scheduleOnRN(closeSheet); }));
    plusOut.set(withDelay(DURATION.plusLead, withSpring(0, SPRING.panelOut)));
  }, [blur, clearLead, closeSheet, gridOpacity, menuOpacity, morph, open, plusOut]);

  const showSheet = useCallback(
    (next: Sheet) => {
      setSheet(next);
      setMode(next);
      pulseBlur();
      morph.set(withSpring(1, SPRING.panel));
      menuOpacity.set(withTiming(0, { duration: DURATION.crossfade, easing: EASE_FADE }));
      gridOpacity.set(withTiming(1, { duration: DURATION.crossfade, easing: EASE_FADE }));
    },
    [gridOpacity, menuOpacity, morph, pulseBlur],
  );

  const backToMenu = useCallback(() => {
    setMode("menu");
    setSelected([]);
    pulseBlur();
    morph.set(withSpring(0, SPRING.panel));
    menuOpacity.set(withTiming(1, { duration: DURATION.crossfade, easing: EASE_FADE }));
    gridOpacity.set(withTiming(0, { duration: DURATION.crossfade, easing: EASE_FADE }));
  }, [gridOpacity, menuOpacity, morph, pulseBlur]);

  const handleFiles = useCallback(async () => {
    dismiss();
    const atts = await pickFiles();
    if (atts.length) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onAddAttachments(atts);
    }
  }, [dismiss, onAddAttachments]);

  const onMenuActionInternal = useCallback(
    (action: MenuAction) => {
      if (action === "photos") showSheet("photos");
      else if (action === "camera") showSheet("camera");
      else if (action === "files") void handleFiles();
      else {
        if (onMenuAction) onMenuAction(action);
        dismiss();
      }
    },
    [dismiss, handleFiles, onMenuAction, showSheet],
  );

  const togglePhoto = useCallback((photo: LibraryPhoto) => {
    Haptics.selectionAsync();
    setSelected((prev) => (prev.includes(photo.id) ? prev.filter((id) => id !== photo.id) : [...prev, photo.id]));
  }, []);

  const settleAttachment = useCallback(() => {
    setFlights([]);
    setSelected([]);
    closeSheet();
    open.set(0);
    morph.set(0);
    attach.set(0);
    gridOpacity.set(0);
    menuOpacity.set(1);
    blur.set(0);
  }, [attach, blur, closeSheet, gridOpacity, menuOpacity, morph, open]);

  const attachAndLeave = useCallback(
    (leaving: Flight[]) => {
      setFlights(leaving);
      Promise.all(leaving.map((f) => libraryPhotoToAttachment(f.photo.id))).then((arr) => {
        const atts = arr.filter((a): a is Attachment => !!a);
        if (atts.length) onAddAttachments(atts);
      });
      setClosing(true);
      blur.set(withTiming(1, { duration: DURATION.panel, easing: EASE_FADE }));
      gridOpacity.set(withTiming(0, { duration: DURATION.crossfade, easing: EASE_FADE }));
      morph.set(withSpring(0, SPRING.panelOut));
      open.set(withSpring(0, SPRING.panelOut));
      plusOut.set(withDelay(DURATION.plusLead, withSpring(0, SPRING.panelOut)));
      attach.set(withSpring(1, SPRING.attach, (finished) => { "worklet"; if (finished) scheduleOnRN(settleAttachment); }));
    },
    [attach, blur, gridOpacity, morph, onAddAttachments, open, plusOut, settleAttachment],
  );

  const confirmSelection = useCallback(() => {
    const picked = selected.map((id) => photos.find((p) => p.id === id)).filter((p): p is LibraryPhoto => !!p);
    if (!picked.length) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const bottom = composerBottom.get();
    const gridTop = bottom - COMPOSER.rowHeight / 2 + MENU.centerOffset - MENU_HEIGHT / 2;
    const cellSize = gridWidth / GRID.columns - GRID.gap;
    const fallback = { x: GUTTER + (gridWidth - cellSize) / 2, y: gridTop + (gridHeight - cellSize) / 2, w: cellSize, h: cellSize };
    const base = existingCount;
    attachAndLeave(
      picked.map((photo, index) => {
        const cell = gridRef.current?.measureCell(photo.id);
        return { photo, slot: base + index, from: cell ? { x: GUTTER + cell.x, y: gridTop + cell.y, w: cell.w, h: cell.h } : fallback };
      }),
    );
  }, [photos, selected, composerBottom, gridWidth, gridHeight, existingCount, attachAndLeave]);

  const capturePhoto = useCallback(async () => {
    if (capturing.current) return;
    capturing.current = true;
    try {
      const uri = await cameraRef.current?.takePicture();
      if (!uri) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const bottom = composerBottom.get();
      const sheetTop = bottom - COMPOSER.rowHeight / 2 + MENU.centerOffset - MENU_HEIGHT / 2;
      const flight: Flight = { photo: { id: uri }, slot: existingCount, from: { x: GUTTER, y: sheetTop, w: gridWidth, h: gridHeight }, fromRadius: GRID.panelRadius };
      setFlights([flight]);
      const att = await cameraUriToAttachment(uri);
      if (att) onAddAttachments([att]);
      setClosing(true);
      blur.set(withTiming(1, { duration: DURATION.panel, easing: EASE_FADE }));
      gridOpacity.set(withTiming(0, { duration: DURATION.crossfade, easing: EASE_FADE }));
      morph.set(withSpring(0, SPRING.panelOut));
      open.set(withSpring(0, SPRING.panelOut));
      plusOut.set(withDelay(DURATION.plusLead, withSpring(0, SPRING.panelOut)));
      attach.set(withSpring(1, SPRING.attach, (finished) => { "worklet"; if (finished) scheduleOnRN(settleAttachment); }));
    } finally {
      capturing.current = false;
    }
  }, [attach, blur, composerBottom, existingCount, gridHeight, gridWidth, gridOpacity, morph, onAddAttachments, open, plusOut, settleAttachment]);

  const toggle = useCallback(() => {
    if (mode === "closed" && leadTimer.current === null) openMenu();
    else dismiss();
  }, [dismiss, mode, openMenu]);

  useImperativeHandle(ref, () => ({ toggle, open: openMenu, close: dismiss, isOpen: () => mode !== "closed" }), [toggle, openMenu, dismiss, mode]);

  const isFlying = flights.length > 0;
  if (mode === "closed") return null;

  return (
    <OverKeyboardView visible>
      <View pointerEvents={isFlying ? "none" : "box-none"} style={StyleSheet.absoluteFill}>
        <Pressable accessibilityLabel="Close attachment menu" onPress={dismiss} style={StyleSheet.absoluteFill} />
        <AttachmentPanel
          screenHeight={height}
          gridWidth={gridWidth}
          gridHeight={gridHeight}
          interactive={isFlying ? "none" : mode === "menu" ? "menu" : "grid"}
          glass={!closing}
          glassDuration={DURATION.panel / 1000}
          open={open}
          morph={morph}
          menuOpacity={menuOpacity}
          gridOpacity={gridOpacity}
          blur={blur}
          composerBottom={composerBottom}
          menu={<AttachmentMenu onSelect={onMenuActionInternal} />}
          grid={
            sheet === "camera" ? (
              <CameraSheet ref={cameraRef} width={gridWidth} height={gridHeight} facing={facing} flash={flash} lifting={isFlying} />
            ) : (
              <PhotoGrid ref={gridRef} width={gridWidth} height={gridHeight} photos={photos} status={status} selected={selected} lifting={isFlying} onTogglePhoto={togglePhoto} />
            )
          }
        />
        {sheet === "camera" ? (
          <CameraBar
            width={gridWidth}
            active={mode === "camera" && !isFlying}
            fade={gridOpacity}
            flash={flash}
            onBack={backToMenu}
            onCapture={capturePhoto}
            onFlip={() => { Haptics.selectionAsync(); setFacing((v) => (v === "back" ? "front" : "back")); }}
            onToggleFlash={() => { Haptics.selectionAsync(); setFlash((v) => (v === "off" ? "on" : "off")); }}
          />
        ) : (
          <PhotoGridBar width={gridWidth} selected={selected} active={mode === "photos" && !isFlying} fade={gridOpacity} onBack={backToMenu} onConfirm={confirmSelection} />
        )}
        <AttachmentFlight flights={flights} screenWidth={width} attach={attach} strip={strip} composerBottom={composerBottom} />
      </View>
    </OverKeyboardView>
  );
});
