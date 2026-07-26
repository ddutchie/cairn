import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Modal,
  Pressable,
  StyleSheet,
  AppState,
  useWindowDimensions,
} from "react-native";
import { X } from "lucide-react-native";
import { listBreakoutBricks, type BrickKind } from "@/db/queries";
import { haptics } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";

// ── Layout / physics constants ────────────────────────────────────────────────
const STONE_H = 30; // height of each stacked stone
const STONE_GAP = 2; // vertical gap between stones for a "stacked stones" look
const BASE_W_FRAC = 0.62; // first stone's width as a fraction of the field width
const BASE_SPEED = 3.6; // px/frame the sliding stone moves at, at the start
const SPEED_RAMP = 0.12; // added to speed each successful drop
const MAX_SPEED = 8.5;
const PERFECT_EPS = 6; // px alignment tolerance counted as a "perfect" drop
const HUD_H = 96;
const WALL_PAD = 16;
// The moving stone rides this many rows above the current tower top.
const APPROACH_GAP = STONE_H + 10;
// Particle burst when a stone is sliced.
const PARTICLES_PER_SLICE = 8;
const PARTICLE_LIFE = 26; // frames

interface Stone {
  x: number; // left edge
  w: number;
  kind: BrickKind;
  label: string;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

/** Stone colour by entity kind — matches the knowledge-graph token convention. */
function kindColor(kind: BrickKind, t: Theme): string {
  switch (kind) {
    case "project": return t.accent;
    case "note": return t.info;
    case "card": return t.success;
    case "tag": return t.warning;
  }
}

/** Emit a small burst of particles from a sliced-off sliver. */
function spawnSlice(sink: Particle[], x: number, y: number, w: number, color: string): void {
  const cx = x + w / 2;
  for (let i = 0; i < PARTICLES_PER_SLICE; i++) {
    const ang = Math.PI * (0.15 + Math.random() * 0.7) * (Math.random() > 0.5 ? 1 : -1);
    const speed = 2 + Math.random() * 3;
    sink.push({
      x: cx + (Math.random() - 0.5) * w,
      y,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      life: PARTICLE_LIFE,
      maxLife: PARTICLE_LIFE,
      color,
      size: 3 + Math.random() * 3,
    });
  }
}

/**
 * Hidden easter-egg "Cairn" stacking game — a nod to the app's namesake (a cairn
 * is a stack of balanced stones). A stone slides back and forth near the top;
 * tap anywhere to drop it onto the tower. Any overhang is sliced off, so the
 * stack narrows as you go and precision is rewarded. Each stone is a real
 * workspace entity (project / note / task / tag), coloured by kind like the
 * knowledge graph — you're building a cairn out of your own workspace.
 *
 * Triggered from the Cairn icon in an EmptyState (see EmptyState's egg menu).
 *
 * A plain requestAnimationFrame loop drives the sliding stone; the tower renders
 * as a handful of absolutely-positioned Views (no Skia needed), matching the
 * Breakout egg's architecture (stable mutable gameState + published snapshot,
 * AppState-driven pause).
 */
export function StackerGame({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const { width: W, height: H } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(t), [t]);

  const fieldTop = HUD_H;
  const fieldBottom = H;
  const baseW = Math.round((W - WALL_PAD * 2) * BASE_W_FRAC);

  // A pool of real workspace labels to name each stone. Refilled (and reshuffled
  // by re-query) on reset. Consumed top-down; falls back to a generic label if
  // the workspace has fewer entities than stones placed.
  const labelPool = useRef<{ label: string; kind: BrickKind }[]>([]);
  const nextLabel = useCallback((): { label: string; kind: BrickKind } => {
    const pool = labelPool.current;
    if (pool.length > 0) return pool.shift()!;
    // Cycle through kinds if we run out of real entities.
    const kinds: BrickKind[] = ["note", "card", "project", "tag"];
    return { label: "stone", kind: kinds[Math.floor(Math.random() * kinds.length)] };
  }, []);

  // Physics/game state in a stable mutable object (useState initialiser, not
  // useRef, so the refs-during-render lint rule doesn't flag reads). The rAF
  // loop mutates it and publishes an immutable snapshot for rendering.
  const [gameState] = useState(() => ({
    tower: [] as Stone[], // stacked stones, bottom-first
    moving: null as (Stone & { dir: 1 | -1 }) | null,
    particles: [] as Particle[],
    speed: BASE_SPEED,
    running: false,
    paused: false,
    width: W,
    baseW,
    fieldTop,
    fieldBottom,
  }));
  gameState.width = W;
  gameState.baseW = baseW;
  gameState.fieldTop = fieldTop;
  gameState.fieldBottom = fieldBottom;

  interface Snapshot {
    tower: Stone[];
    moving: (Stone & { dir: 1 | -1 }) | null;
    particles: Particle[];
  }
  const [snap, setSnap] = useState<Snapshot>({ tower: [], moving: null, particles: [] });
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [combo, setCombo] = useState(0);
  const [status, setStatus] = useState<"playing" | "lost">("playing");
  const rafRef = useRef<number | null>(null);

  const publish = useCallback(() => {
    const g = gameState;
    setSnap({ tower: g.tower, moving: g.moving, particles: g.particles });
  }, [gameState]);

  // Y (top) of the Nth stone from the bottom — the tower grows UP from the base.
  const stoneTop = useCallback(
    (indexFromBottom: number) => gameState.fieldBottom - (indexFromBottom + 1) * (STONE_H + STONE_GAP),
    [gameState],
  );

  // Spawn a new sliding stone above the current tower top, matching the top
  // stone's width, alternating its start side.
  const spawnMoving = useCallback(() => {
    const g = gameState;
    const top = g.tower[g.tower.length - 1];
    const w = top ? top.w : g.baseW;
    const { label, kind } = nextLabel();
    const fromLeft = g.tower.length % 2 === 0;
    g.moving = {
      x: fromLeft ? WALL_PAD : g.width - WALL_PAD - w,
      w,
      kind,
      label,
      dir: fromLeft ? 1 : -1,
    };
  }, [gameState, nextLabel]);

  const reset = useCallback(() => {
    const g = gameState;
    // Refill the label pool from a fresh workspace sample (query is cheap).
    try {
      labelPool.current = listBreakoutBricks(60);
    } catch {
      labelPool.current = [];
    }
    // Seed the base stone, centred, as a real entity.
    const base = nextLabel();
    g.tower = [{ x: Math.round((g.width - g.baseW) / 2), w: g.baseW, kind: base.kind, label: base.label }];
    g.moving = null;
    g.particles = [];
    g.speed = BASE_SPEED;
    g.running = true;
    g.paused = AppState.currentState !== "active";
    setScore(0);
    setCombo(0);
    setStatus("playing");
    spawnMoving();
    publish();
  }, [gameState, nextLabel, spawnMoving, publish]);

  // Drop the moving stone onto the tower: slice overhang, detect perfect/miss.
  const drop = useCallback(() => {
    const g = gameState;
    if (!g.running || g.paused || !g.moving) return;
    const top = g.tower[g.tower.length - 1];
    const m = g.moving;

    const overlapLeft = Math.max(m.x, top.x);
    const overlapRight = Math.min(m.x + m.w, top.x + top.w);
    const overlap = overlapRight - overlapLeft;

    if (overlap <= 0) {
      // Missed the tower entirely → game over.
      g.moving = null;
      g.running = false;
      haptics.error();
      setStatus("lost");
      setBest((b) => Math.max(b, score));
      publish();
      return;
    }

    // Slice the moving stone down to the overlapping region; spill the sliver as
    // particles for feedback.
    const sliceY = stoneTop(g.tower.length);
    const color = kindColor(m.kind, t);
    const misalign = Math.abs(m.x - top.x);
    const perfect = misalign <= PERFECT_EPS;

    if (!perfect) {
      // Left/right slivers become particles.
      if (m.x < overlapLeft) spawnSlice(g.particles, m.x, sliceY + STONE_H / 2, overlapLeft - m.x, color);
      if (m.x + m.w > overlapRight) spawnSlice(g.particles, overlapRight, sliceY + STONE_H / 2, (m.x + m.w) - overlapRight, color);
    }

    const placedX = perfect ? top.x : overlapLeft;
    const placedW = perfect ? top.w : overlap;
    g.tower.push({ x: placedX, w: placedW, kind: m.kind, label: m.label });

    if (perfect) {
      haptics.success();
      setCombo((c) => c + 1);
    } else {
      haptics.rigid();
      setCombo(0);
    }
    setScore((s) => s + 1);

    // Ramp speed, cap it, spawn the next stone.
    g.speed = Math.min(MAX_SPEED, g.speed + SPEED_RAMP);
    g.moving = null;
    spawnMoving();
    publish();
  }, [gameState, stoneTop, t, score, spawnMoving, publish]);

  // Main loop: slide the moving stone, advance particles.
  useEffect(() => {
    if (!visible) {
      gameState.running = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      return;
    }
    let started = false;
    const step = () => {
      if (!started) { started = true; reset(); }
      const g = gameState;
      if (g.running && !g.paused) {
        // Slide the moving stone, bouncing off the walls.
        const m = g.moving;
        if (m) {
          m.x += g.speed * m.dir;
          if (m.x <= WALL_PAD) { m.x = WALL_PAD; m.dir = 1; }
          if (m.x + m.w >= g.width - WALL_PAD) { m.x = g.width - WALL_PAD - m.w; m.dir = -1; }
        }
        // Advance particles (gravity + fade).
        if (g.particles.length) {
          const alive: Particle[] = [];
          for (const p of g.particles) {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.35;
            p.vx *= 0.98;
            p.life -= 1;
            if (p.life > 0) alive.push(p);
          }
          g.particles = alive;
        }
      }
      publish();
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, W, H]);

  // Pause physics whenever the app isn't foregrounded (see BreakoutGame for the
  // rationale — rAF bursts on return would teleport the sliding stone).
  useEffect(() => {
    if (!visible) return;
    const sub = AppState.addEventListener("change", (state) => {
      gameState.paused = state !== "active";
    });
    return () => sub.remove();
  }, [visible, gameState]);

  if (!visible) return null;

  // Only render the top ~14 stones (the rest have scrolled below the screen);
  // the tower conceptually keeps growing but off-screen rows needn't paint.
  const VISIBLE_ROWS = Math.ceil((fieldBottom - fieldTop) / (STONE_H + STONE_GAP)) + 1;
  const firstVisible = Math.max(0, snap.tower.length - VISIBLE_ROWS);

  return (
    <Modal visible transparent={false} animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable style={styles.root} onPress={drop} accessibilityLabel="Drop stone">
        {/* HUD */}
        <View style={[styles.hud, { height: HUD_H }]}>
          <View>
            <Text style={styles.hudTitle}>Cairn</Text>
            <Text style={styles.hudScore}>
              Stacked {score}
              {combo > 1 ? `  ·  ${combo}× perfect` : ""}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn} accessibilityLabel="Close game">
            <X size={20} color={t.textSecondary} />
          </Pressable>
        </View>

        {status === "playing" ? (
          <Text style={styles.tapHint} pointerEvents="none">Tap anywhere to drop</Text>
        ) : null}

        {/* Tower stones */}
        {snap.tower.map((s, i) =>
          i >= firstVisible ? (
            <View
              key={i}
              style={[
                styles.stone,
                {
                  left: s.x,
                  top: stoneTop(i),
                  width: s.w,
                  height: STONE_H,
                  backgroundColor: kindColor(s.kind, t),
                },
              ]}
            >
              <Text style={styles.stoneLabel} numberOfLines={1}>{s.label}</Text>
            </View>
          ) : null,
        )}

        {/* Moving stone (rides above the tower top) */}
        {snap.moving ? (
          <View
            style={[
              styles.stone,
              styles.moving,
              {
                left: snap.moving.x,
                top: stoneTop(snap.tower.length - 1) - APPROACH_GAP,
                width: snap.moving.w,
                height: STONE_H,
                backgroundColor: kindColor(snap.moving.kind, t),
              },
            ]}
          >
            <Text style={styles.stoneLabel} numberOfLines={1}>{snap.moving.label}</Text>
          </View>
        ) : null}

        {/* Particles (sliced slivers) */}
        {snap.particles.map((p, i) => (
          <View
            key={`p${i}`}
            style={{
              position: "absolute",
              left: p.x - p.size / 2,
              top: p.y - p.size / 2,
              width: p.size,
              height: p.size,
              borderRadius: p.size / 2,
              backgroundColor: p.color,
              opacity: p.life / p.maxLife,
            }}
            pointerEvents="none"
          />
        ))}

        {/* End overlay */}
        {status !== "playing" ? (
          <View style={styles.overlay} pointerEvents="box-none">
            <Text style={styles.overlayTitle}>Toppled!</Text>
            <Text style={styles.overlaySub}>
              Stacked {score}{best > 0 ? `  ·  best ${Math.max(best, score)}` : ""}
            </Text>
            <Pressable onPress={reset} style={styles.playAgain}>
              <Text style={styles.playAgainText}>Stack again</Text>
            </Pressable>
            <Pressable onPress={onClose} hitSlop={12} style={styles.overlayClose}>
              <Text style={styles.overlayCloseText}>Close</Text>
            </Pressable>
          </View>
        ) : null}
      </Pressable>
    </Modal>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.background },
    hud: {
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingBottom: 10,
    },
    hudTitle: { ...typeScale.title, color: t.textPrimary },
    hudScore: { ...typeScale.caption, color: t.textTertiary, marginTop: 2, fontVariant: ["tabular-nums"] },
    closeBtn: { padding: 6 },
    tapHint: {
      ...typeScale.caption,
      color: t.textTertiary,
      textAlign: "center",
      marginTop: 4,
    },
    stone: {
      position: "absolute",
      borderRadius: 7,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 6,
    },
    // Subtle lift on the in-flight stone so it reads as "not yet placed".
    moving: { opacity: 0.92 },
    stoneLabel: { ...typeScale.micro, color: "#fff", fontWeight: "600" },
    overlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.scrim,
    },
    overlayTitle: { ...typeScale.display, color: t.textPrimary },
    overlaySub: { ...typeScale.subtitle, color: t.textSecondary, marginTop: 6, fontVariant: ["tabular-nums"] },
    playAgain: {
      marginTop: 24,
      backgroundColor: t.accent,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 12,
    },
    playAgainText: { ...typeScale.control, color: t.accentFg },
    overlayClose: { marginTop: 14 },
    overlayCloseText: { ...typeScale.control, color: t.textTertiary },
  });
}
