import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { useRouter, type Href } from "expo-router";
import { Canvas, Circle, Path, Skia } from "@shopify/react-native-skia";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import * as d3 from "d3-geo";
import { SegmentedControl } from "@/components/SegmentedControl";
import { PressableScale } from "@/components/PressableScale";
import { EmptyState } from "@/components/EmptyState";
import { haptics } from "@/haptics";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";
import land from "@cairn/shared/people/land-110m.json";
import { cityOf, groupBySpot, type MapGroup } from "@cairn/shared/people/map-spots";
import { ZONE_COORDS } from "@cairn/shared/people/zone-coords";
import { sunAt } from "@cairn/shared/people/sun";
import { availabilityAt, localHourAt, systemZone, zoneOffsetMinutes, type Availability } from "@cairn/shared/people/zones";
import type { PersonSummary } from "@cairn/shared/types/people-view";

/**
 * People, Map: where everyone is with the night side shaded, so you can tell
 * who is probably offline. People sit on their time zone's principal city (or
 * their own city when it agrees with the zone). The slider moves time forward
 * or back to answer "who is online at 3pm tomorrow". A flat map you can pinch
 * and drag, or a globe you drag to turn. Same placement and availability maths
 * as the desktop map (`shared/people`), drawn with Skia instead of D3 SVG.
 */
type Kind = "flat" | "globe";
const WORDS: Record<Availability, string> = { work: "At work", edge: "Early or late", asleep: "Probably asleep" };
const MAX_K = 8;
const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** The night hemisphere: the circle centred opposite the sun. */
const nightCircle = (ms: number) => {
  const s = sunAt(ms);
  return d3.geoCircle().center([s.lon + 180, -s.lat]).radius(90)();
};
const toPath = (d: string | null) => (d ? Skia.Path.MakeFromSVGString(d) : null);

interface View2 { k: number; x: number; y: number }

export function PeopleMap({ people }: { people: readonly PersonSummary[] }) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const { width: winW } = useWindowDimensions();
  const [box, setBox] = useState(0);
  const W = box || Math.max(280, winW - 24);
  const [kind, setKind] = useState<Kind>("flat");
  const H = kind === "globe" ? Math.round(W * 0.9) : Math.round(W * 0.52);
  const [offset, setOffset] = useState(0);
  const [zoneKey, setZoneKey] = useState<string | null>(null);
  const [view, setView] = useState<View2>({ k: 1, x: 0, y: 0 });
  const [rotate, setRotate] = useState<[number, number] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const atMs = now + offset * 3_600_000;
  const at = new Date(atMs);

  const me = people.find((p) => p.isMe) ?? null;
  // The globe starts facing you (your zone's city), else the zone this phone is in.
  const home = ZONE_COORDS[me?.timezone ?? systemZone()] ?? [20, 0];
  const rot: [number, number] = rotate ?? [-home[1], -clamp(home[0], -60, 60)];
  const [rot0, rot1] = rot;

  const projection = useMemo(() => {
    if (kind === "globe") {
      return d3.geoOrthographic().translate([W / 2, H / 2]).scale((Math.min(W, H) / 2 - 6) * view.k).rotate([rot0, rot1]).clipAngle(90).precision(0.6);
    }
    const base = d3.geoNaturalEarth1().fitSize([W, H], { type: "Sphere" });
    const [tx, ty] = base.translate();
    return base.scale(base.scale() * view.k).translate([tx * view.k + view.x, ty * view.k + view.y]);
  }, [kind, view, rot0, rot1, W, H]);
  const geo = useMemo(() => d3.geoPath(projection), [projection]);

  const { groups, unplaced } = useMemo(() => groupBySpot(people), [people]);
  const sun = sunAt(at);
  const facing = (lon: number, lat: number) => kind !== "globe" || d3.geoDistance([lon, lat], [-rot[0], -rot[1]]) < Math.PI / 2 - 0.02;

  const paths = useMemo(() => ({
    sphere: toPath(geo({ type: "Sphere" })),
    grid: toPath(geo(d3.geoGraticule10())),
    land: toPath(geo(land as unknown as d3.GeoPermissibleObjects)),
    night: toPath(geo(nightCircle(atMs))),
  }), [geo, atMs]);

  const availOf = (g: MapGroup): Availability => availabilityAt(localHourAt(g.tz, at) ?? 12);
  const color = (a: Availability) => (a === "work" ? t.success : a === "edge" ? t.warning : t.textTertiary);
  const markers = groups.flatMap((g) => {
    const pt = facing(g.lon, g.lat) ? projection([g.lon, g.lat]) : null;
    if (!pt || pt[0] < -8 || pt[0] > W + 8 || pt[1] < -8 || pt[1] > H + 8) return [];
    return [{ g, x: pt[0], y: pt[1] }];
  });
  const sunPt = facing(sun.lon, sun.lat) ? projection([sun.lon, sun.lat]) : null;

  // Gestures: pinch zooms; drag turns the globe and pans a zoomed flat map; tap picks a marker.
  // The gesture handlers live on a plain object so they always read the latest view without re-creating the gesture.
  const input = useMemo(() => new MapInput(), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hands the latest values to the gesture handlers every render
  useEffect(() => {
    input.sync({ view, rot, markers, kind, W, H, setView, setRotate, pick: (g) => { haptics.selection(); setZoneKey(g.key); } });
  });
  const gesture = useMemo(() => mapGesture(input), [input]);

  const switchKind = (k: Kind) => { setKind(k); setView({ k: 1, x: 0, y: 0 }); setRotate(null); };
  const myZone = me?.timezone && zoneOffsetMinutes(me.timezone, at) !== null ? me.timezone : systemZone();
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: myZone, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(at);
  const sel = zoneKey ? groups.find((g) => g.key === zoneKey) : undefined;
  const selHour = sel ? localHourAt(sel.tz, at) ?? 0 : 0;

  if (people.length === 0) {
    return <View style={s.root}><EmptyState title="No people yet" subtitle="Add the people you work with and where they are shows up here." /></View>;
  }

  return (
    <ScrollView style={s.root} contentContainerStyle={s.scroll} contentInsetAdjustmentBehavior="automatic">
      <Text style={s.sectionTitle}>Around the world</Text>
      <Text style={s.note}>{`${offset === 0 ? "Now" : `${offset > 0 ? "+" : ""}${offset}h`}, ${when} in ${cityOf(myZone)}`}</Text>

      <View style={s.card}>
        <View style={s.sliderRow}>
          <TimeSlider value={offset} onChange={setOffset} t={t} />
          <PressableScale
            style={[s.nowBtn, offset === 0 && { opacity: 0.4 }]}
            disabled={offset === 0}
            onPress={() => { haptics.selection(); setOffset(0); }}
            accessibilityLabel="Back to now"
          >
            <Text style={s.nowText}>Now</Text>
          </PressableScale>
        </View>
        <Text style={s.hint}>Slide to see who is online later or earlier</Text>

        <SegmentedControl
          style={s.kindSwitch}
          tintColor={t.accent}
          fontStyle={{ color: t.textSecondary, fontSize: 13, fontWeight: "600" }}
          activeFontStyle={{ color: t.accentFg, fontSize: 13, fontWeight: "600" }}
          values={["Map", "Globe"]}
          selectedIndex={kind === "flat" ? 0 : 1}
          onChange={(e) => switchKind(e.nativeEvent.selectedSegmentIndex === 1 ? "globe" : "flat")}
        />

        <GestureDetector gesture={gesture}>
          <View
            style={[s.canvas, { height: H }]}
            onLayout={(e: LayoutChangeEvent) => setBox(Math.round(e.nativeEvent.layout.width))}
            accessibilityLabel={kind === "globe" ? "Globe with day and night" : "World map with day and night"}
          >
            <Canvas style={StyleSheet.absoluteFill}>
              {paths.sphere ? <Path path={paths.sphere} color={t.surface} /> : null}
              {paths.sphere ? <Path path={paths.sphere} color={t.border} style="stroke" strokeWidth={1} /> : null}
              {paths.grid ? <Path path={paths.grid} color={withAlpha(t.border, 0.6)} style="stroke" strokeWidth={0.4} /> : null}
              {paths.land ? <Path path={paths.land} color={withAlpha(t.textPrimary, 0.13)} /> : null}
              {paths.night ? <Path path={paths.night} color={withAlpha(t.textPrimary, 0.16)} /> : null}
              {sunPt ? <Circle cx={sunPt[0]} cy={sunPt[1]} r={8} color={t.surface} /> : null}
              {sunPt ? <Circle cx={sunPt[0]} cy={sunPt[1]} r={8} color={t.warning} style="stroke" strokeWidth={2} /> : null}
              {sunPt ? <Circle cx={sunPt[0]} cy={sunPt[1]} r={3} color={t.warning} /> : null}
              {markers.map(({ g, x, y }) => {
                const on = g.key === zoneKey;
                const r = g.people.length > 1 ? 10 : 7;
                return [
                  <Circle key={`${g.key}-f`} cx={x} cy={y} r={r} color={color(availOf(g))} />,
                  <Circle key={`${g.key}-s`} cx={x} cy={y} r={r} color={on ? t.textPrimary : t.surface} style="stroke" strokeWidth={2} />,
                ];
              })}
            </Canvas>
            {markers.filter((m) => m.g.people.length > 1).map(({ g, x, y }) => (
              <Text key={g.key} pointerEvents="none" style={[s.count, { left: x - 10, top: y - 10 }]}>{g.people.length}</Text>
            ))}
          </View>
        </GestureDetector>

        <View style={s.legend}>
          {(["work", "edge", "asleep"] as const).map((k) => (
            <View key={k} style={s.legendItem}>
              <View style={[s.dot, { backgroundColor: color(k) }]} />
              <Text style={s.legendText}>{k === "work" ? "At work, 9 to 17 local" : k === "edge" ? "Early or late" : "Probably asleep, 22 to 07"}</Text>
            </View>
          ))}
        </View>
        <Text style={s.hint}>
          {`Shaded area is night; the sun marks where it is overhead. ${kind === "globe" ? "Drag to turn the globe." : "Pinch to zoom, drag to move."}`}
        </Text>
      </View>

      <Text style={s.sectionTitle}>Who is there</Text>
      {sel ? (
        <View style={s.card}>
          <Text style={s.note}>{`${sel.label}, ${hhmm(selHour)} local`}</Text>
          <View style={s.statusRow}>
            <View style={[s.dot, { backgroundColor: color(availOf(sel)) }]} />
            <Text style={[s.status, { color: color(availOf(sel)) }]}>{WORDS[availOf(sel)]}</Text>
          </View>
          {sel.people.map((p) => (
            <PressableScale
              key={p.id}
              style={s.person}
              onPress={() => router.push({ pathname: "/workspace/people/[id]", params: { id: p.id } } as Href)}
              accessibilityLabel={p.name}
            >
              <Text style={s.personName} numberOfLines={1}>{p.name}{p.isMe ? " (you)" : ""}</Text>
              <Text style={s.chevron}>›</Text>
            </PressableScale>
          ))}
        </View>
      ) : (
        <Text style={s.hint}>Tap a marker on the map.</Text>
      )}

      {unplaced.length > 0 ? (
        <>
          <Text style={s.sectionTitle}>{`Not on the map  ${unplaced.length}`}</Text>
          <View style={s.card}>
            {unplaced.map((p) => (
              <PressableScale
                key={p.id}
                style={s.person}
                onPress={() => router.push({ pathname: "/workspace/people/[id]", params: { id: p.id } } as Href)}
                accessibilityLabel={p.name}
              >
                <Text style={s.personName} numberOfLines={1}>{p.name}</Text>
                <Text style={s.chevron}>›</Text>
              </PressableScale>
            ))}
            <Text style={s.hint}>Set a time zone on their page, for example Europe/London, to place them.</Text>
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

/** A plain slider over -24h..+24h in half-hour steps (no slider library in the app). */
function TimeSlider({ value, onChange, t }: { value: number; onChange: (v: number) => void; t: Theme }) {
  const [w, setW] = useState(0);
  const set = useCallback((x: number) => {
    if (!w) return;
    const v = Math.round((clamp(x / w, 0, 1) * 48 - 24) * 2) / 2;
    onChange(v);
  }, [w, onChange]);
  const gesture = useMemo(
    () => Gesture.Pan().runOnJS(true).minDistance(0).onBegin((e) => set(e.x)).onUpdate((e) => set(e.x)),
    [set],
  );
  const frac = (value + 24) / 48;
  return (
    <GestureDetector gesture={gesture}>
      <View style={{ flex: 1, height: 36, justifyContent: "center" }} onLayout={(e) => setW(e.nativeEvent.layout.width)} accessibilityRole="adjustable" accessibilityLabel="Hours from now" accessibilityValue={{ text: `${value} hours` }}>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: t.border }} />
        <View style={{ position: "absolute", left: Math.min(frac, 0.5) * w, width: Math.abs(frac - 0.5) * w, height: 4, borderRadius: 2, backgroundColor: t.accent }} />
        <View style={{ position: "absolute", left: frac * w - 12, width: 24, height: 24, borderRadius: 12, backgroundColor: t.surface, borderWidth: 2, borderColor: t.accent }} />
      </View>
    </GestureDetector>
  );
}

interface Live {
  view: View2; rot: [number, number]; markers: { g: MapGroup; x: number; y: number }[]; kind: Kind; W: number; H: number;
  setView: (f: (p: View2) => View2) => void; setRotate: (r: [number, number]) => void; pick: (g: MapGroup) => void;
}

/**
 * Pinch zooms; drag turns the globe and pans a zoomed flat map; a tap picks the nearest marker.
 * The gesture callbacks only call methods on this object (like the graph's engine): Reanimated
 * copies whatever `this` a worklet closes over, so the state has to live behind a method call.
 */
class MapInput {
  private live: Live | null = null;
  private lastX = 0;
  private lastY = 0;
  private lastK = 1;
  sync(l: Live) { this.live = l; }
  private clampView(v: View2): View2 {
    const { W, H, kind } = this.live!;
    const k = clamp(v.k, 1, kind === "globe" ? 4 : MAX_K);
    return { k, x: clamp(v.x, W - W * k, 0), y: clamp(v.y, H - H * k, 0) };
  }
  panStart() { this.lastX = 0; this.lastY = 0; }
  panMove(tx: number, ty: number) {
    const l = this.live; if (!l) return;
    const dx = tx - this.lastX; const dy = ty - this.lastY;
    this.lastX = tx; this.lastY = ty;
    if (l.kind === "globe") {
      const speed = 0.35 / l.view.k;
      l.setRotate([l.rot[0] + dx * speed, clamp(l.rot[1] - dy * speed, -85, 85)]);
    } else if (l.view.k > 1) {
      l.setView((p) => this.clampView({ ...p, x: p.x + dx, y: p.y + dy }));
    }
  }
  pinchStart() { this.lastK = this.live?.view.k ?? 1; }
  pinchMove(scale: number, fx: number, fy: number) {
    const l = this.live; if (!l) return;
    const k = clamp(this.lastK * scale, 1, l.kind === "globe" ? 4 : MAX_K);
    l.setView((p) => {
      if (l.kind === "globe") return { ...p, k };
      const f = k / p.k;
      return this.clampView({ k, x: fx - (fx - p.x) * f, y: fy - (fy - p.y) * f });
    });
  }
  tap(x: number, y: number) {
    const l = this.live; if (!l) return;
    let best: MapGroup | null = null; let bestD = 26;
    for (const m of l.markers) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bestD) { best = m.g; bestD = d; }
    }
    if (best) l.pick(best);
  }
}

function mapGesture(input: MapInput) {
  const pan = Gesture.Pan().runOnJS(true).maxPointers(1).minDistance(4)
    .onStart(() => input.panStart())
    .onUpdate((e) => input.panMove(e.translationX, e.translationY));
  const pinch = Gesture.Pinch().runOnJS(true)
    .onStart(() => input.pinchStart())
    .onUpdate((e) => input.pinchMove(e.scale, e.focalX, e.focalY));
  const tap = Gesture.Tap().runOnJS(true).maxDistance(10).onEnd((e, ok) => { if (ok) input.tap(e.x, e.y); });
  return Gesture.Race(Gesture.Simultaneous(pan, pinch), tap);
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.background },
    scroll: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 48 },
    sectionTitle: { ...typeScale.overline, color: t.textTertiary, marginTop: 16, marginBottom: 4, marginLeft: 4 },
    note: { ...typeScale.caption, color: t.textTertiary, marginLeft: 4, marginBottom: 6 },
    hint: { ...typeScale.caption, color: t.textTertiary, marginTop: 6 },
    card: { borderRadius: 12, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, padding: 12 },
    sliderRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    nowBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
    nowText: { ...typeScale.label, color: t.textPrimary },
    kindSwitch: { height: 32, marginTop: 10, marginBottom: 10 },
    canvas: { borderRadius: 8, overflow: "hidden", backgroundColor: t.background },
    count: { position: "absolute", width: 20, textAlign: "center", ...typeScale.micro, color: t.surface },
    legend: { marginTop: 10, gap: 4 },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
    legendText: { ...typeScale.caption, color: t.textSecondary },
    dot: { width: 8, height: 8, borderRadius: 4 },
    statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
    status: { ...typeScale.label },
    person: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.borderSubtle },
    personName: { ...typeScale.control, color: t.textPrimary, flex: 1 },
    chevron: { fontSize: 20, color: t.textTertiary },
  });
}
