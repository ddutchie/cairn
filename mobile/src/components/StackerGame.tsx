import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Modal, Pressable, StyleSheet, AppState, useWindowDimensions } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { X } from "lucide-react-native";
import { listBreakoutBricks, type BrickKind } from "@/db/queries";
import { getMeta, setMeta } from "@/db";
import { haptics } from "@/haptics";
import { InlineConfetti } from "@/components/Confetti";
import { RollingText } from "@/components/RollingText";
import { FloatText, GameOverCard, ParticlePool, PARTICLE_POOL, PopChip, useShake } from "@/components/game/GameKit";
import { comboTier, packParticles } from "@/lib/game-feel";
import { useMotion } from "@/lib/use-motion";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";

// Persisted best score key (device-global meta — survives source switches,
// never synced).
const STACKER_BEST_KEY = "stacker_best";
function loadStackerBest(): number {
  const raw = getMeta(STACKER_BEST_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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
const KINDS: BrickKind[] = ["project", "note", "card", "tag"];

interface Stone {
  x: number; // left edge
  w: number;
  kind: BrickKind;
  label: string;
  /** Placed flush on the stone below: gets the landing ring. */
  perfect?: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: number; // index into the kind palette
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
function spawnSlice(sink: Particle[], x: number, y: number, w: number, kind: BrickKind): void {
  const cx = x + w / 2;
  const color = KINDS.indexOf(kind);
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
  if (sink.length > PARTICLE_POOL) sink.splice(0, sink.length - PARTICLE_POOL);
}

/** Haptic detent for the nth perfect stone in a row: the longer the streak, the more it lands. */
function firePerfectHaptic(streak: number): void {
  haptics.success();
  const tier = comboTier(streak);
  if (tier === "tick") return;
  setTimeout(() => (tier === "flourish" ? haptics.impactHeavy() : tier === "thud" ? haptics.rigid() : haptics.impactMedium()), 90);
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
 * A requestAnimationFrame loop drives the sliding stone, but it writes shared values rather
 * than React state: the sliding stone, the slice particles and the camera all animate on the
 * UI thread. React re-renders only when a stone lands, the score changes or the run ends.
 */
export function StackerGame({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const motion = useMotion();
  const { width: W, height: H } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(t), [t]);
  const { style: shakeStyle, shake } = useShake();

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
  // useRef, so the refs-during-render lint rule doesn't flag reads).
  const [gameState] = useState(() => ({
    tower: [] as Stone[], // stacked stones, bottom-first
    moving: null as (Stone & { dir: 1 | -1 }) | null,
    particles: [] as Particle[],
    hadParticles: false,
    speed: BASE_SPEED,
    score: 0,
    combo: 0,
    running: false,
    paused: false,
    reduced: false,
    width: W,
    baseW,
    fieldTop,
    fieldBottom,
  }));
  gameState.width = W;
  gameState.baseW = baseW;
  gameState.fieldTop = fieldTop;
  gameState.fieldBottom = fieldBottom;
  gameState.reduced = motion.reduced;

  // UI-thread render state.
  const movingX = useSharedValue(0);
  const fall = useSharedValue(0);
  const camera = useSharedValue(0);
  const particleBuf = useSharedValue<number[]>(packParticles([], PARTICLE_POOL));

  const [tower, setTower] = useState<Stone[]>([]);
  // The sliding stone's identity and width; its x lives in `movingX`.
  const [moving, setMoving] = useState<Stone | null>(null);
  const [score, setScore] = useState(0);
  // Best score persists across sessions via the meta store. Seeded once on mount.
  const [best, setBest] = useState(loadStackerBest);
  const [combo, setCombo] = useState(0);
  const [status, setStatus] = useState<"playing" | "lost">("playing");
  // Bumped to fire a confetti burst inside the modal (the app-root ConfettiHost
  // renders behind this fullscreen Modal, so it can't be seen here). 0 = idle.
  const [celebrate, setCelebrate] = useState(0);
  // Whether the just-finished run set a new personal best (drives the overlay).
  const [newRecord, setNewRecord] = useState(false);
  // "Perfect" callout: bumped per perfect stone, with the streak it reached and where it landed.
  const [callout, setCallout] = useState({ key: 0, streak: 0, x: 0, index: 0 });
  const rafRef = useRef<number | null>(null);

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
    movingX.set(g.moving.x);
    fall.set(0);
    setMoving({ x: g.moving.x, w, kind, label });
  }, [gameState, nextLabel, movingX, fall]);

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
    g.hadParticles = false;
    g.speed = BASE_SPEED;
    g.score = 0;
    g.combo = 0;
    g.running = true;
    g.paused = AppState.currentState !== "active";
    particleBuf.set(packParticles([], PARTICLE_POOL));
    camera.set(0);
    setTower(g.tower);
    setScore(0);
    setCombo(0);
    setStatus("playing");
    setNewRecord(false);
    // Clear any leftover confetti trigger from a previous run — otherwise a
    // stale non-zero `celebrate` fires a burst the instant the game reopens
    // (and keeps the cannon mounted, dragging the frame rate down).
    setCelebrate(0);
    spawnMoving();
  }, [gameState, nextLabel, spawnMoving, particleBuf, camera]);

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
      // Missed the tower entirely → game over. The stone falls away and the field shakes.
      g.moving = null;
      g.running = false;
      setStatus("lost");
      shake();
      fall.set(motion.reduced ? 1 : withTiming(1, { duration: 380 }));
      // New personal best? Celebrate with a confetti burst; otherwise the
      // standard error buzz. Persist the record either way. (Toasts live behind
      // this fullscreen Modal, so the win is announced in the end overlay.)
      const prevBest = loadStackerBest();
      const isRecord = g.score > prevBest;
      if (isRecord) {
        setMeta(STACKER_BEST_KEY, String(g.score));
        setBest(g.score);
        haptics.success();
        if (!motion.reduced) setCelebrate((n) => n + 1);
      } else {
        haptics.error();
        setBest((b) => Math.max(b, g.score));
      }
      setNewRecord(isRecord);
      return;
    }

    // Slice the moving stone down to the overlapping region; spill the sliver as
    // particles for feedback.
    const sliceY = stoneTop(g.tower.length);
    const misalign = Math.abs(m.x - top.x);
    const perfect = misalign <= PERFECT_EPS;

    if (!perfect && !motion.reduced) {
      // Left/right slivers become particles.
      if (m.x < overlapLeft) spawnSlice(g.particles, m.x, sliceY + STONE_H / 2, overlapLeft - m.x, m.kind);
      if (m.x + m.w > overlapRight) spawnSlice(g.particles, overlapRight, sliceY + STONE_H / 2, (m.x + m.w) - overlapRight, m.kind);
    }

    const placedX = perfect ? top.x : overlapLeft;
    const placedW = perfect ? top.w : overlap;
    g.tower = [...g.tower, { x: placedX, w: placedW, kind: m.kind, label: m.label, perfect }];
    setTower(g.tower);

    if (perfect) {
      g.combo += 1;
      firePerfectHaptic(g.combo);
      setCallout((c) => ({ key: c.key + 1, streak: g.combo, x: placedX + placedW / 2, index: g.tower.length - 1 }));
    } else {
      g.combo = 0;
      haptics.rigid();
    }
    setCombo(g.combo);
    g.score += 1;
    setScore(g.score);

    // Ramp speed, cap it, spawn the next stone.
    g.speed = Math.min(MAX_SPEED, g.speed + SPEED_RAMP);
    g.moving = null;
    spawnMoving();
  }, [gameState, stoneTop, spawnMoving, shake, fall, motion.reduced]);

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
      if (!g.paused) {
        // Slide the moving stone, bouncing off the walls.
        const m = g.running ? g.moving : null;
        if (m) {
          m.x += g.speed * m.dir;
          if (m.x <= WALL_PAD) { m.x = WALL_PAD; m.dir = 1; }
          if (m.x + m.w >= g.width - WALL_PAD) { m.x = g.width - WALL_PAD - m.w; m.dir = -1; }
          movingX.set(m.x);
        }
        // Advance particles (gravity + fade) — also after the run ends, so a final burst finishes.
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
        // Write the pool while anything is alive, plus one final clearing write.
        if (g.particles.length || g.hadParticles) {
          particleBuf.set(packParticles(g.particles, PARTICLE_POOL));
          g.hadParticles = g.particles.length > 0;
        }
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // Depend only on `visible` — the loop reads live dimensions off `gameState`
    // (kept in sync every render, above), so a width/height change (rotation,
    // keyboard) no longer recreates the effect and wipes the tower/score.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Pause physics whenever the app isn't foregrounded (see BreakoutGame for the
  // rationale — rAF bursts on return would teleport the sliding stone).
  useEffect(() => {
    if (!visible) return;
    const sub = AppState.addEventListener("change", (state) => {
      gameState.paused = state !== "active";
    });
    return () => sub.remove();
  }, [visible, gameState]);

  // Camera: once the tower is tall enough to fill the field, scroll the view up
  // so the tower TOP stays at a stable screen position (a fixed number of rows
  // below fieldTop) instead of climbing off the top of the screen as it grows.
  // The offset moves a world-space layer, so lower stones slide down and off the
  // bottom while the growing top stays put; it springs rather than jumping.
  const ROW_H = STONE_H + STONE_GAP;
  const VISIBLE_ROWS = Math.ceil((fieldBottom - fieldTop) / ROW_H) + 1;
  // Keep the tower top ~3 rows below the HUD so the moving stone (which rides
  // APPROACH_GAP above the top) stays comfortably on screen.
  const TOP_MARGIN_ROWS = 3;
  const overflowRows = Math.max(0, tower.length - (VISIBLE_ROWS - TOP_MARGIN_ROWS));
  const cameraY = overflowRows * ROW_H;
  useEffect(() => {
    camera.set(motion.reduced ? cameraY : withSpring(cameraY, { damping: 24, stiffness: 280 }));
  }, [cameraY, motion.reduced, camera]);

  const palette = useMemo(() => KINDS.map((k) => kindColor(k, t)), [t]);
  const worldStyle = useAnimatedStyle(() => ({ transform: [{ translateY: camera.get() }] }));
  const movingStyle = useAnimatedStyle(() => ({
    opacity: 1 - fall.get(),
    transform: [{ translateX: movingX.get() }, { translateY: fall.get() * 260 }, { rotate: `${fall.get() * 0.35}rad` }],
  }));

  if (!visible) return null;

  // Cull anything scrolled outside the field (with a row of slack for the camera spring).
  const onScreen = (top: number) => {
    const y = top + cameraY;
    return y + STONE_H > fieldTop - ROW_H && y < fieldBottom + ROW_H;
  };
  const movingTop = stoneTop(tower.length - 1) - APPROACH_GAP;

  return (
    <Modal visible transparent={false} animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable style={styles.root} onPress={drop} accessibilityLabel="Drop stone">
        <Animated.View style={[StyleSheet.absoluteFill, shakeStyle]} pointerEvents="box-none">
          {/* HUD */}
          <View style={[styles.hud, { height: HUD_H }]}>
            <View>
              <Text style={styles.hudTitle}>Cairn</Text>
              <View style={styles.hudRow}>
                <Text style={styles.hudScore}>Stacked </Text>
                <RollingText text={String(score)} style={styles.hudScore} />
                {combo > 1 ? (
                  <PopChip pulseKey={combo}>
                    <Text style={styles.hudCombo}>{`  ·  ${combo}× perfect`}</Text>
                  </PopChip>
                ) : null}
              </View>
            </View>
            <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn} accessibilityLabel="Close game">
              <X size={20} color={t.textSecondary} />
            </Pressable>
          </View>

          {status === "playing" ? (
            <Text style={styles.tapHint} pointerEvents="none">Tap anywhere to drop</Text>
          ) : null}

          {/* World layer: tower, sliding stone, particles and callouts, scrolled by the camera. */}
          <Animated.View style={[StyleSheet.absoluteFill, worldStyle]} pointerEvents="none">
            {tower.map((s, i) =>
              onScreen(stoneTop(i)) ? (
                <StoneView
                  key={i}
                  stone={s}
                  top={stoneTop(i)}
                  fresh={i === tower.length - 1 && i > 0}
                  color={palette[KINDS.indexOf(s.kind)]}
                  styles={styles}
                  ringColor={t.accent}
                />
              ) : null,
            )}

            {/* Moving stone (rides above the tower top) */}
            {moving ? (
              <Animated.View
                style={[
                  styles.stone,
                  styles.moving,
                  { left: 0, top: movingTop, width: moving.w, height: STONE_H, backgroundColor: palette[KINDS.indexOf(moving.kind)] },
                  movingStyle,
                ]}
              >
                <Text style={styles.stoneLabel} numberOfLines={1}>{moving.label}</Text>
              </Animated.View>
            ) : null}

            {/* Particles (sliced slivers) */}
            <ParticlePool data={particleBuf} palette={palette} />

            <FloatText
              fireKey={callout.key}
              text={callout.streak > 1 ? `Perfect ×${callout.streak}` : "Perfect"}
              color={t.accent}
              left={callout.x}
              top={stoneTop(callout.index) - 26}
            />
          </Animated.View>
        </Animated.View>

        {/* End overlay */}
        {status !== "playing" ? (
          <GameOverCard
            title={newRecord ? "New high score!" : "Toppled!"}
            scoreLabel="Stacked"
            score={score}
            bestLine={best > 0 ? (newRecord ? `New best ${Math.max(best, score)}` : `Best ${Math.max(best, score)}`) : undefined}
            record={newRecord}
            primaryLabel="Stack again"
            onPrimary={reset}
            onClose={onClose}
          />
        ) : null}

        {/* Confetti on a new personal best — rendered inside the Modal so it's
            visible over the game (the app-root host sits behind it). */}
        <InlineConfetti fireKey={celebrate} />
      </Pressable>
    </Modal>
  );
}

/**
 * A placed stone. The newest one squashes on landing and springs to full height; a perfect
 * landing also sends out a ring in the accent colour.
 */
const StoneView = memo(function StoneView({
  stone,
  top,
  fresh,
  color,
  ringColor,
  styles,
}: {
  stone: Stone;
  top: number;
  fresh: boolean;
  color: string;
  ringColor: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  const motion = useMotion();
  // Decided once at mount: only the stone that has just landed animates.
  const [animate] = useState(() => fresh && !motion.reduced);
  const land = useSharedValue(animate ? 1 : 0);
  const ring = useSharedValue(0);
  useEffect(() => {
    if (!animate) return;
    land.set(withSpring(0, { damping: 13, stiffness: 520 }));
    if (stone.perfect) ring.set(withSequence(withTiming(0.001, { duration: 0 }), withTiming(1, { duration: 340 })));
  }, [animate, stone.perfect, land, ring]);
  const body = useAnimatedStyle(() => ({
    transform: [{ scaleY: 1 - land.get() * 0.28 }, { scaleX: 1 + land.get() * 0.05 }],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: ring.get() > 0 ? 0.9 * (1 - ring.get()) : 0,
    transform: [{ scaleX: 1 + ring.get() * 0.14 }, { scaleY: 1 + ring.get() * 0.9 }],
  }));
  return (
    <>
      {stone.perfect ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.ring, { left: stone.x, top, width: stone.w, height: STONE_H, borderColor: ringColor, backgroundColor: withAlpha(ringColor, 0.18) }, ringStyle]}
        />
      ) : null}
      <Animated.View
        style={[styles.stone, { left: stone.x, top, width: stone.w, height: STONE_H, backgroundColor: color, transformOrigin: "bottom" }, body]}
      >
        <Text style={styles.stoneLabel} numberOfLines={1}>{stone.label}</Text>
      </Animated.View>
    </>
  );
});

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
    hudRow: { flexDirection: "row", alignItems: "center", marginTop: 2 },
    hudScore: { ...typeScale.caption, color: t.textTertiary, fontVariant: ["tabular-nums"] },
    hudCombo: { ...typeScale.caption, color: t.accent, fontWeight: "700" },
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
    ring: { position: "absolute", borderRadius: 9, borderWidth: 2 },
    // Subtle lift on the in-flight stone so it reads as "not yet placed".
    moving: { opacity: 0.92 },
    stoneLabel: { ...typeScale.micro, color: t.accentFg, fontWeight: "600" },
  });
}
