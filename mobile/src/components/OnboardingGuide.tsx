import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Image,
} from "react-native";
import {
  Cloud,
  CloudOff,
  FolderCheck,
  Monitor,
  Check,
  RefreshCw,
  ArrowRight,
} from "lucide-react-native";
import { useTheme, type as typeScale, withAlpha, type Theme } from "@/theme";
import { setActiveSource, getDeviceId } from "@/db";
import { iCloudAvailable, getSyncFolderPath, syncFolderLabel } from "@/sync/folder";
import { listSources, type SyncSource } from "@/sync/fs-transport";
import { PressableScale } from "@/components/PressableScale";
import { haptics } from "@/haptics";

const CAIRN_ICON = require("../../assets/splashIcon.png");

/**
 * Where the desktop app connects its half of the sync. Kept in one place so the
 * copy stays in lockstep with the desktop UI labels (Settings → Device Sync →
 * "Choose folder…", see src/components/settings/SyncSettings.tsx).
 */
const DESKTOP_PATH = "Settings › Device Sync › Choose folder…";

/**
 * The live-progress connection status the guide walks through. Unlike the old
 * static step list, each phase reflects real device state and auto-advances:
 *
 *  - "checking"   — probing iCloud + ensuring the Cairn/sync folder exists.
 *  - "no-icloud"  — iCloud isn't signed in; nothing can sync until it is.
 *  - "waiting"    — folder is ready, but no desktop workspace has appeared yet.
 *                   This is the state where the user must act on the desktop.
 *  - "found"      — one or more workspaces were discovered; ready to connect.
 */
type Phase = "checking" | "no-icloud" | "waiting" | "found";

interface Probe {
  phase: Phase;
  folderReady: boolean;
  sources: SyncSource[];
}

/**
 * First-run guided onboarding shown when the app has no active source AND the
 * shared iCloud folder holds no published workspace yet — i.e. the exact spot a
 * new user gets stuck. It makes the (non-obvious) ordering explicit:
 *
 *   1. Opening this app is what CREATES `iCloud Drive › Cairn › sync` — so the
 *      desktop has somewhere to point at. We confirm the folder live.
 *   2. On the computer, connect Device Sync to that same folder.
 *   3. We poll iCloud; the moment the desktop publishes, a "Connect" button
 *      appears and taps straight through to the workspace.
 *
 * Detection reuses the same folder + listSources round-trip as the picker, so
 * there's no separate code path to keep in sync.
 */
export function OnboardingGuide({
  onConnected,
}: {
  onConnected: (workspaceId: string) => void;
}) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [probe, setProbe] = useState<Probe>({
    phase: "checking",
    folderReady: false,
    sources: [],
  });
  const [scanning, setScanning] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      if (!(await iCloudAvailable())) {
        setProbe({ phase: "no-icloud", folderReady: false, sources: [] });
        return;
      }
      // Resolving the folder path creates `Documents/sync` inside the app's
      // iCloud container if it doesn't exist — this is the side-effect that
      // surfaces `iCloud Drive › Cairn › sync` for the desktop to find.
      const folder = await getSyncFolderPath();
      if (!folder) {
        setProbe({ phase: "no-icloud", folderReady: false, sources: [] });
        return;
      }
      const found = await listSources(folder, getDeviceId());
      setProbe({
        phase: found.length > 0 ? "found" : "waiting",
        folderReady: true,
        sources: found,
      });
    } catch {
      // Treat scan failures as "still waiting" — the folder may just not have
      // propagated yet. The user can Refresh, and auto-poll keeps trying.
      setProbe((p) => ({ ...p, phase: p.folderReady ? "waiting" : "checking" }));
    } finally {
      setScanning(false);
    }
  }, []);

  // Initial scan + gentle auto-poll while waiting, so the "Connect" button can
  // appear on its own once the desktop publishes (no manual Refresh needed).
  useEffect(() => {
    const id = setTimeout(() => void scan(), 0);
    return () => clearTimeout(id);
  }, [scan]);

  useEffect(() => {
    if (probe.phase !== "waiting") return;
    const iv = setInterval(() => void scan(), 6000);
    return () => clearInterval(iv);
  }, [probe.phase, scan]);

  const connect = useCallback(
    (workspaceId: string) => {
      haptics.success();
      setActiveSource(workspaceId);
      onConnected(workspaceId);
    },
    [onConnected],
  );

  const { phase, folderReady, sources } = probe;
  const iCloudOk = phase !== "no-icloud" && phase !== "checking";

  return (
    <View style={[s.container, { backgroundColor: t.background }]}>
      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.brand}>
          <Image source={CAIRN_ICON} style={s.icon} resizeMode="contain" />
          <Text style={[s.title, { color: t.textPrimary }]}>
            {phase === "found" ? "Connect a workspace" : "Set up sync"}
          </Text>
          <Text style={[s.subtitle, { color: t.textTertiary }]}>
            {phase === "found"
              ? "Your computer has published to iCloud. Pick a workspace below to open it on this phone."
              : "Cairn keeps your phone and computer in step through a shared iCloud folder. Let's connect them — it takes a minute."}
          </Text>
        </View>

        <View style={s.steps}>
          {/* Step 1 — iCloud + folder. Done automatically by opening the app. */}
          <StepCard
            t={t}
            s={s}
            n={1}
            title="This phone is ready"
            done={folderReady}
            active={phase === "checking" || phase === "no-icloud"}
            icon={
              phase === "no-icloud" ? (
                <CloudOff size={18} color={t.danger} />
              ) : (
                <Cloud size={18} color={folderReady ? t.success : t.accent} />
              )
            }
          >
            {phase === "no-icloud" ? (
              <Text style={[s.body, { color: t.danger }]}>
                iCloud isn&apos;t signed in. Open the iOS Settings app, sign in
                to iCloud with iCloud Drive on, then come back and Refresh.
              </Text>
            ) : (
              <Text style={[s.body, { color: t.textSecondary }]}>
                Opening Cairn created its folder in iCloud Drive:
                {"\n"}
                <Text style={[s.mono, { color: t.textPrimary }]}>
                  {syncFolderLabel()}
                </Text>
                {folderReady ? " — ready." : "…"}
              </Text>
            )}
          </StepCard>

          {/* Step 2 — connect the desktop. The part users get stuck on. */}
          <StepCard
            t={t}
            s={s}
            n={2}
            title="Connect on your computer"
            done={phase === "found"}
            active={phase === "waiting"}
            dimmed={!iCloudOk}
            icon={<Monitor size={18} color={iCloudOk ? t.accent : t.textTertiary} />}
          >
            <Text style={[s.body, { color: t.textSecondary }]}>
              On the Mac or PC that has your workspace, open Cairn desktop and go
              to:
            </Text>
            <View style={[s.pathBox, { backgroundColor: t.surface2, borderColor: t.border }]}>
              <Text style={[s.mono, { color: t.textPrimary }]}>{DESKTOP_PATH}</Text>
            </View>
            <Text style={[s.body, { color: t.textSecondary }]}>
              Choose the same iCloud folder this phone just made —{" "}
              <Text style={{ color: t.textPrimary, fontWeight: "600" }}>
                iCloud Drive › Cairn › sync
              </Text>
              . Your workspace publishes there, then appears below.
            </Text>
          </StepCard>

          {/* Step 3 — the live result: connect once discovered. */}
          <StepCard
            t={t}
            s={s}
            n={3}
            title="Connect this phone"
            done={false}
            active={phase === "found"}
            dimmed={phase !== "found"}
            icon={<FolderCheck size={18} color={phase === "found" ? t.success : t.textTertiary} />}
          >
            {phase === "found" ? (
              <>
                <Text style={[s.body, { color: t.textSecondary }]}>
                  Found {sources.length === 1 ? "a workspace" : `${sources.length} workspaces`}. Tap to connect:
                </Text>
                {sources.map((src) => (
                  <PressableScale
                    key={src.workspaceId}
                    haptic={false}
                    style={[s.wsItem, { backgroundColor: t.accentDim, borderColor: withAlpha(t.accent, 0.4) }]}
                    onPress={() => connect(src.workspaceId)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[s.wsName, { color: t.textPrimary }]}>
                        {src.name ?? "Workspace"}
                      </Text>
                      <Text style={[s.wsId, { color: t.textTertiary }]} numberOfLines={1}>
                        {src.workspaceId}
                      </Text>
                    </View>
                    <ArrowRight size={18} color={t.accent} />
                  </PressableScale>
                ))}
              </>
            ) : (
              <View style={s.waitingRow}>
                {scanning ? (
                  <ActivityIndicator size="small" color={t.textTertiary} />
                ) : (
                  <View style={[s.pulseDot, { backgroundColor: t.textTertiary }]} />
                )}
                <Text style={[s.body, { color: t.textTertiary, flex: 1 }]}>
                  Waiting for your computer to publish… give iCloud a moment to
                  sync. This checks automatically.
                </Text>
              </View>
            )}
          </StepCard>
        </View>
      </ScrollView>

      <View style={[s.footer, { borderTopColor: t.border, backgroundColor: t.background }]}>
        <PressableScale
          style={[s.refresh, { borderColor: t.border }]}
          onPress={() => void scan()}
          disabled={scanning}
        >
          <RefreshCw size={15} color={scanning ? t.textTertiary : t.accent} />
          <Text style={[s.refreshText, { color: scanning ? t.textTertiary : t.accent }]}>
            {scanning ? "Checking…" : "Refresh"}
          </Text>
        </PressableScale>
      </View>
    </View>
  );
}

/** One numbered card in the guided checklist. */
function StepCard({
  t,
  s,
  n,
  title,
  icon,
  children,
  done,
  active,
  dimmed = false,
}: {
  t: Theme;
  s: ReturnType<typeof makeStyles>;
  n: number;
  title: string;
  icon: ReactNode;
  children: ReactNode;
  done: boolean;
  active: boolean;
  dimmed?: boolean;
}) {
  return (
    <View
      style={[
        s.card,
        {
          backgroundColor: t.surface,
          borderColor: active ? withAlpha(t.accent, 0.5) : t.border,
          opacity: dimmed ? 0.55 : 1,
        },
      ]}
    >
      <View style={s.cardHead}>
        <View
          style={[
            s.badge,
            {
              backgroundColor: done ? t.success : t.accentDim,
            },
          ]}
        >
          {done ? (
            <Check size={15} color={t.accentFg} strokeWidth={3} />
          ) : (
            <Text style={[s.badgeNum, { color: t.accent }]}>{n}</Text>
          )}
        </View>
        <Text style={[s.cardTitle, { color: t.textPrimary }]}>{title}</Text>
        <View style={s.cardIcon}>{icon}</View>
      </View>
      <View style={s.cardBody}>{children}</View>
    </View>
  );
}

function makeStyles(_t: Theme) {
  return StyleSheet.create({
    container: { flex: 1 },
    scroll: { padding: 20, paddingTop: 64, paddingBottom: 24 },
    brand: { alignItems: "center", marginBottom: 28 },
    icon: { width: 68, height: 68, marginBottom: 12 },
    title: { ...typeScale.display },
    subtitle: {
      ...typeScale.body,
      marginTop: 8,
      textAlign: "center",
      maxWidth: 320,
    },
    steps: { gap: 14 },
    card: {
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      padding: 16,
    },
    cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
    badge: {
      width: 26,
      height: 26,
      borderRadius: 13,
      alignItems: "center",
      justifyContent: "center",
    },
    badgeNum: { ...typeScale.label, fontWeight: "700" },
    cardTitle: { ...typeScale.title, flex: 1 },
    cardIcon: { marginLeft: "auto" },
    cardBody: { marginTop: 12, gap: 10 },
    body: { ...typeScale.body },
    mono: { fontFamily: "Courier", fontSize: 13.5, fontWeight: "600" },
    pathBox: {
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      paddingVertical: 10,
      paddingHorizontal: 12,
    },
    wsItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 14,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      marginTop: 4,
    },
    wsName: { ...typeScale.subtitle },
    wsId: { ...typeScale.caption, marginTop: 2, fontFamily: "Courier" },
    waitingRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    pulseDot: { width: 8, height: 8, borderRadius: 4 },
    footer: {
      borderTopWidth: StyleSheet.hairlineWidth,
      padding: 16,
      paddingBottom: 28,
      alignItems: "center",
    },
    refresh: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
    },
    refreshText: { ...typeScale.control },
  });
}
