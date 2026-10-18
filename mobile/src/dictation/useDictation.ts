import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import type { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { toast } from "@/components/Toast";
import { haptics } from "@/haptics";
import { applyResult, mergeDictation, normalizeLevel } from "./merge";
import { dictationVocabulary } from "./vocabulary";

type SpeechNative = typeof ExpoSpeechRecognitionModule;

// Loaded optionally and never imported as a value from the package: a binary built
// before this module existed (or Expo Go) simply reports dictation as unavailable.
const native: SpeechNative | null = requireOptionalNativeModule<SpeechNative>("ExpoSpeechRecognition");

/** Safety stop so a forgotten toggle can't keep the microphone open. */
const MAX_LISTEN_MS = 2 * 60 * 1000;
/** If the recognizer never reports `end` after we stop it, stop showing "listening". */
const STOP_GRACE_MS = 2000;

function isAvailable(): boolean {
  try {
    return native != null && native.isRecognitionAvailable();
  } catch {
    return false;
  }
}

function deviceLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

export interface Dictation {
  /** False when speech recognition can't run here (old binary, simulator, unsupported). */
  available: boolean;
  listening: boolean;
  /** Microphone level 0–1 for animating a waveform without re-rendering. */
  level: SharedValue<number>;
  /** Begin listening. Resolves false if it didn't start (permission denied, unavailable). */
  start: () => Promise<boolean>;
  /** Stop and keep what was heard. */
  stop: () => void;
  /** Stop and throw away what was heard, restoring the text from before. */
  cancel: () => void;
}

/**
 * Dictation into a text field. Streams the transcript into `text` as you speak, on top of
 * whatever was already there, and restores it on cancel. Stopping keeps the text so it can
 * be corrected before sending; nothing is ever sent automatically.
 *
 * Prefers on-device recognition (private, works offline) and falls back to the system
 * service when the device or language doesn't support it.
 */
export function useDictation({ text, setText }: { text: string; setText: (t: string) => void }): Dictation {
  const [available] = useState(isAvailable);
  const [listening, setListening] = useState(false);
  const level = useSharedValue(0);

  // Latest values for use inside native event callbacks (synced after render).
  const textRef = useRef(text);
  const setTextRef = useRef(setText);
  useEffect(() => {
    textRef.current = text;
    setTextRef.current = setText;
  }, [text, setText]);

  const base = useRef("");
  const committed = useRef("");
  const active = useRef(false); // a session is starting or running
  const ignoreResults = useRef(false);
  const started = useRef(false); // native recognition is actually running
  const abortStart = useRef(false); // stop/cancel arrived while permissions were pending
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (maxTimer.current) clearTimeout(maxTimer.current);
    if (graceTimer.current) clearTimeout(graceTimer.current);
    maxTimer.current = null;
    graceTimer.current = null;
  };

  const finishSession = useCallback(() => {
    clearTimers();
    active.current = false;
    started.current = false;
    setListening(false);
    level.set(0);
  }, [level]);

  useEffect(() => {
    if (!native) return;
    const subs = [
      native.addListener("result", (ev) => {
        if (ignoreResults.current) return;
        const transcript = ev.results[0]?.transcript ?? "";
        const next = applyResult(committed.current, transcript, ev.isFinal);
        committed.current = next.committed;
        setTextRef.current(mergeDictation(base.current, next.spoken));
      }),
      native.addListener("volumechange", (ev) => level.set(normalizeLevel(ev.value))),
      native.addListener("end", finishSession),
      native.addListener("error", (ev) => {
        // Silence and our own abort are normal outcomes, not failures.
        if (ev.error === "no-speech" || ev.error === "aborted" || ev.error === "speech-timeout") return;
        if (ev.error === "not-allowed" || ev.error === "service-not-allowed") notifyDenied();
        else if (ev.error !== "interrupted") toast.warning("Dictation stopped unexpectedly. Try again.");
        finishSession();
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [finishSession, level]);

  const stop = useCallback(() => {
    if (!native) return;
    if (!active.current) return;
    abortStart.current = true; // cancels a start still awaiting permission
    // Nothing native to stop yet: start() sees the flag and bails. Arming the grace timer here
    // would let it end a *later* session in the UI while the microphone stays open.
    if (!started.current) return;
    haptics.selection();
    try {
      native.stop();
    } catch {
      finishSession();
      return;
    }
    if (graceTimer.current) clearTimeout(graceTimer.current);
    graceTimer.current = setTimeout(finishSession, STOP_GRACE_MS);
  }, [finishSession]);

  const cancel = useCallback(() => {
    if (!native) return;
    if (!active.current) return;
    abortStart.current = true;
    ignoreResults.current = true;
    haptics.warning();
    if (started.current) setTextRef.current(base.current);
    try {
      native.abort();
    } catch {
      /* already stopped */
    }
    finishSession();
  }, [finishSession]);

  const start = useCallback(async (): Promise<boolean> => {
    if (!native || active.current) return false;
    clearTimers();
    active.current = true;
    abortStart.current = false;
    try {
      let perm = await native.getPermissionsAsync();
      if (!perm.granted) perm = await native.requestPermissionsAsync();
      if (!perm.granted) {
        active.current = false;
        notifyDenied();
        return false;
      }
      // Released (or cancelled) while the permission prompt was up: don't start late.
      if (abortStart.current) {
        active.current = false;
        return false;
      }
      base.current = textRef.current;
      committed.current = "";
      ignoreResults.current = false;
      level.set(0);
      native.start({
        lang: deviceLocale(),
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        requiresOnDeviceRecognition: native.supportsOnDeviceRecognition(),
        contextualStrings: dictationVocabulary(),
        iosTaskHint: "dictation",
        volumeChangeEventOptions: { enabled: true, intervalMillis: 80 },
      });
      started.current = true;
      setListening(true);
      haptics.impactMedium();
      maxTimer.current = setTimeout(stop, MAX_LISTEN_MS);
      return true;
    } catch {
      active.current = false;
      toast.warning("Couldn't start dictation.");
      return false;
    }
  }, [level, stop]);

  // Leaving the app while listening: stop and keep the text, like putting the phone down.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      // Not "inactive": system permission alerts and Control Center also report it, and
      // stopping then would abort the first dictation while it awaits the prompt.
      if (next === "background") stop();
    });
    return () => sub.remove();
  }, [stop]);

  // Unmounting mid-session: end it without writing into a screen that's gone.
  useEffect(
    () => () => {
      clearTimers();
      if (!native || !active.current) return;
      // A start still awaiting the permission prompt must not begin capturing after unmount.
      abortStart.current = true;
      ignoreResults.current = true;
      try {
        native.abort();
      } catch {
        /* already stopped */
      }
    },
    [],
  );

  return { available, listening, level, start, stop, cancel };
}

function notifyDenied() {
  toast.warning("Allow microphone and speech recognition to dictate.", {
    actionText: "Settings",
    onActionPress: () => void Linking.openSettings(),
    haptic: false,
  });
}
